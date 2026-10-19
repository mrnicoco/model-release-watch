import { releaseMessage, sendNtfy, type NtfyMessage } from "./notify";
import { parseAtom, parseFeedBoot, SchemaError, type ModelRelease } from "./source";

export interface Env {
  STATE: KVNamespace;
  NTFY_TOPIC: string;
  RUN_TOKEN: string;
  SOURCE_URL: string;
  FALLBACK_FEED_URL: string;
  SITE_BASE: string;
  NTFY_SERVER: string;
  MAX_NOTIFICATIONS_PER_RUN: string;
  STALE_AFTER_HOURS: string;
  FAILURES_BEFORE_ALERT: string;
}

type AlertKind = "fetch" | "schema" | "degraded" | "stale" | "ntfy";

export interface Health {
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastNewAt?: string;
  lastSource?: "page" | "atom";
  consecutiveFailures: number;
  lastError?: string;
  lastResult?: string;
  modelsInSource?: number;
  alertsSentAt: Partial<Record<AlertKind, string>>;
}

export interface RunResult {
  status: "seeded" | "unchanged" | "notified" | "no-new" | "fetch-error" | "schema-error" | "misconfigured";
  source?: "page" | "atom";
  newModels: string[];
  notified: number;
  failedNotifications: number;
  alerts: AlertKind[];
  dryRun: boolean;
  messages?: NtfyMessage[];
  error?: string;
}

const KEY_SEEN = "seen";
const KEY_ETAG = "etag";
const KEY_HEALTH = "health";
const ALERT_COOLDOWN_MS = 24 * 3600 * 1000;
const UA = "model-release-watch/1.0 (+https://github.com; cloudflare-worker)";

function int(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function readHealth(kv: KVNamespace): Promise<Health> {
  const h = await kv.get<Health>(KEY_HEALTH, "json");
  return h ?? { consecutiveFailures: 0, alertsSentAt: {} };
}

type Fetched =
  | { kind: "unchanged" }
  | { kind: "ok"; models: ModelRelease[]; etag: string | null; source: "page" | "atom"; degraded?: string }
  | { kind: "error"; schema: boolean; error: string };

/** Source principale (page HTML), puis flux Atom si elle échoue. */
async function fetchModels(env: Env, previousEtag: string | null): Promise<Fetched> {
  let primaryError: string;
  let primarySchema = false;
  try {
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "text/html" };
    if (previousEtag) headers["If-None-Match"] = previousEtag;
    const res = await fetch(env.SOURCE_URL, { headers });
    if (res.status === 304) return { kind: "unchanged" };
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${env.SOURCE_URL}`);
    const models = parseFeedBoot(await res.text(), env.SITE_BASE);
    return { kind: "ok", models, etag: res.headers.get("ETag"), source: "page" };
  } catch (e) {
    primaryError = errMsg(e);
    primarySchema = e instanceof SchemaError;
  }

  if (env.FALLBACK_FEED_URL) {
    try {
      const res = await fetch(env.FALLBACK_FEED_URL, { headers: { "User-Agent": UA, Accept: "application/atom+xml" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${env.FALLBACK_FEED_URL}`);
      const models = parseAtom(await res.text(), env.SITE_BASE);
      return { kind: "ok", models, etag: null, source: "atom", degraded: primaryError };
    } catch (e) {
      primaryError += ` | secours : ${errMsg(e)}`;
    }
  }
  return { kind: "error", schema: primarySchema, error: primaryError };
}

export async function run(env: Env, opts: { dryRun?: boolean; now?: Date } = {}): Promise<RunResult> {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const siteBase = env.SITE_BASE.replace(/\/+$/, "");
  const result: RunResult = { status: "no-new", newModels: [], notified: 0, failedNotifications: 0, alerts: [], dryRun };
  if (dryRun) result.messages = [];

  const health = await readHealth(env.STATE);
  health.lastRunAt = nowIso;

  const send = async (msg: NtfyMessage): Promise<boolean> => {
    if (dryRun) {
      result.messages!.push(msg);
      return true;
    }
    try {
      await sendNtfy(env.NTFY_SERVER || "https://ntfy.sh", env.NTFY_TOPIC, msg);
      return true;
    } catch (e) {
      console.error("ntfy", e);
      return false;
    }
  };

  /** Alerte technique, au plus une par type et par 24 h. */
  const alert = async (kind: AlertKind, title: string, message: string) => {
    const last = health.alertsSentAt[kind];
    if (last && now.getTime() - Date.parse(last) < ALERT_COOLDOWN_MS) return;
    if (await send({ title: `⚠️ model-release-watch : ${title}`, message, priority: 2, tags: ["warning"] })) {
      health.alertsSentAt[kind] = nowIso;
      result.alerts.push(kind);
    }
  };

  const finish = async () => {
    health.lastResult = result.status;
    if (!dryRun) await env.STATE.put(KEY_HEALTH, JSON.stringify(health));
    return result;
  };

  if (!env.NTFY_TOPIC) {
    // Peut arriver quelques secondes entre `wrangler deploy` et `wrangler secret bulk`.
    result.status = "misconfigured";
    result.error = health.lastError = "Secret NTFY_TOPIC absent";
    return finish();
  }

  const seenRaw = await env.STATE.get<string[]>(KEY_SEEN, "json");
  const seen = new Set(seenRaw ?? []);
  const isFirstRun = seenRaw === null;

  // 1. Récupération
  const fetched = await fetchModels(env, isFirstRun ? null : await env.STATE.get(KEY_ETAG));

  if (fetched.kind === "error") {
    health.consecutiveFailures += 1;
    result.error = health.lastError = fetched.error;
    if (fetched.schema) {
      result.status = "schema-error";
      await alert("schema", "format de la source inattendu", fetched.error);
    } else {
      result.status = "fetch-error";
      if (health.consecutiveFailures >= int(env.FAILURES_BEFORE_ALERT, 3)) {
        await alert("fetch", "source injoignable", `${health.consecutiveFailures} échecs consécutifs.\n${fetched.error}`);
      }
    }
    return finish();
  }

  health.consecutiveFailures = 0;
  health.lastSuccessAt = nowIso;
  health.lastError = undefined;

  if (fetched.kind === "unchanged") {
    result.status = "unchanged";
    result.source = "page";
  } else {
    const { models, etag, source } = fetched;
    result.source = health.lastSource = source;
    health.modelsInSource = models.length;
    if (fetched.degraded) {
      health.lastError = fetched.degraded;
      await alert(
        "degraded",
        "source principale en échec, flux Atom utilisé",
        `${fetched.degraded}\nLes notifications continuent, sans niveau d'importance.`,
      );
    }

    if (isFirstRun) {
      // 2a. Premier lancement : on mémorise l'existant sans notifier chaque modèle.
      result.status = "seeded";
      health.lastNewAt = nowIso;
      await send({
        title: "model-release-watch activé",
        message: `${models.length} modèles récents mémorisés. Les prochains vous seront notifiés.`,
        priority: 2,
        tags: ["white_check_mark"],
        click: `${siteBase}/releases/model/`,
      });
      if (!dryRun) {
        await env.STATE.put(KEY_SEEN, JSON.stringify(models.map((m) => m.slug)));
        if (etag) await env.STATE.put(KEY_ETAG, etag);
      }
    } else {
      // 2b. Nouveaux modèles = slugs jamais vus (l'ordre des dates n'est pas fiable)
      const fresh = models.filter((m) => !seen.has(m.slug)).sort((a, b) => a.date.localeCompare(b.date));
      result.newModels = fresh.map((m) => m.slug);
      const max = int(env.MAX_NOTIFICATIONS_PER_RUN, 10);

      for (const m of fresh.slice(0, max)) {
        if (await send(releaseMessage(m))) {
          seen.add(m.slug);
          result.notified += 1;
        } else {
          result.failedNotifications += 1; // reste « non vu » → nouvel essai au prochain passage
        }
      }

      const overflow = fresh.slice(max);
      if (overflow.length > 0) {
        const ok = await send({
          title: `+${overflow.length} autres nouveaux modèles`,
          message: overflow.map((m) => `• ${m.vendor ? m.vendor + " — " : ""}${m.name}`).join("\n").slice(0, 3500),
          priority: 3,
          tags: ["robot"],
          click: `${siteBase}/releases/model/`,
        });
        if (ok) overflow.forEach((m) => seen.add(m.slug));
        else result.failedNotifications += overflow.length;
      }

      if (result.failedNotifications > 0) {
        await alert("ntfy", "échec d'envoi", `${result.failedNotifications} notification(s) non envoyée(s), nouvel essai au prochain passage.`);
      }
      if (fresh.length > result.failedNotifications) health.lastNewAt = nowIso;
      result.status = fresh.length > 0 ? "notified" : "no-new";

      if (!dryRun) {
        if (fresh.length > 0) await env.STATE.put(KEY_SEEN, JSON.stringify([...seen]));
        // On ne mémorise l'ETag que si tout est parti, sinon un 304 masquerait les échecs.
        if (etag && result.failedNotifications === 0) await env.STATE.put(KEY_ETAG, etag);
      }
    }
  }

  // 3. Source muette ?
  const staleMs = int(env.STALE_AFTER_HOURS, 72) * 3600 * 1000;
  if (health.lastNewAt && now.getTime() - Date.parse(health.lastNewAt) > staleMs) {
    await alert(
      "stale",
      "aucun nouveau modèle",
      `Rien de nouveau depuis le ${health.lastNewAt.slice(0, 16).replace("T", " ")} UTC. La source est peut-être arrêtée.`,
    );
  }

  return finish();
}
