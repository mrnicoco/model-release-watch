import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, type Env } from "../src/watch";
import { ATOM, BOOT, bootItem, bootWith, pageWith } from "./helpers";

/** KV en mémoire, suffisant pour get/put. */
function fakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}
type FakeKV = ReturnType<typeof fakeKV>;

const PAGE = "https://ai-tldr.dev/releases/model/";
const FEED = "https://ai-tldr.dev/feed.xml";
const NTFY = "https://ntfy.example";

function makeEnv(): Env & { STATE: FakeKV } {
  return {
    STATE: fakeKV(),
    NTFY_TOPIC: "topic-secret",
    RUN_TOKEN: "t",
    SOURCE_URL: PAGE,
    FALLBACK_FEED_URL: FEED,
    SITE_BASE: "https://ai-tldr.dev",
    NTFY_SERVER: NTFY,
    MAX_NOTIFICATIONS_PER_RUN: "2",
    STALE_AFTER_HOURS: "72",
    FAILURES_BEFORE_ALERT: "3",
  } as unknown as Env & { STATE: FakeKV };
}

let pageResponse: () => Response;
let feedResponse: () => Response;
let ntfyOk: boolean;
let ntfy: any[];
let pageRequests: RequestInit[];

beforeEach(() => {
  ntfyOk = true;
  ntfy = [];
  pageRequests = [];
  feedResponse = () => new Response(ATOM, { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(NTFY)) {
        ntfy.push(JSON.parse(String(init?.body)));
        return new Response(ntfyOk ? "{}" : "boom", { status: ntfyOk ? 200 : 500 });
      }
      if (url === FEED) return feedResponse();
      pageRequests.push(init ?? {});
      return pageResponse();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const page = (boot: unknown, etag = '"v1"') => () => new Response(pageWith(boot), { status: 200, headers: { ETag: etag } });
const seed = (env: ReturnType<typeof makeEnv>, slugs: string[]) => env.STATE.store.set("seen", JSON.stringify(slugs));

describe("run", () => {
  it("premier lancement : mémorise sans notifier chaque modèle", async () => {
    const env = makeEnv();
    pageResponse = page(BOOT);
    const r = await run(env);
    expect(r).toMatchObject({ status: "seeded", source: "page" });
    expect(ntfy).toHaveLength(1);
    expect(ntfy[0].title).toBe("model-release-watch activé");
    expect(JSON.parse(env.STATE.store.get("seen")!)).toHaveLength(4);
    expect(env.STATE.store.get("etag")).toBe('"v1"');
  });

  it("notifie les nouveaux modèles, du plus ancien au plus récent", async () => {
    const env = makeEnv();
    seed(env, ["a"]);
    pageResponse = page(bootWith([bootItem("c", "major", "2026-10-12"), bootItem("a"), bootItem("b", "seismic", "2026-10-11")]), '"v2"');
    const r = await run(env);
    expect(r).toMatchObject({ status: "notified", notified: 2, newModels: ["b", "c"] });
    expect(ntfy.map((b) => b.title)).toEqual(["Lab — B", "Lab — C"]);
    expect(ntfy[0]).toMatchObject({ topic: "topic-secret", priority: 5, click: "https://ai-tldr.dev/releases/b/", message: "Tagline b\nseismic · 2026-10-11" });
    expect(new Set(JSON.parse(env.STATE.store.get("seen")!))).toEqual(new Set(["a", "b", "c"]));
    expect(env.STATE.store.get("etag")).toBe('"v2"');
  });

  it("envoie l'ETag mémorisé (requête conditionnelle) et gère le 304", async () => {
    const env = makeEnv();
    seed(env, ["a"]);
    env.STATE.store.set("etag", '"v1"');
    env.STATE.store.set("health", JSON.stringify({ consecutiveFailures: 0, alertsSentAt: {}, lastNewAt: new Date().toISOString() }));
    pageResponse = () => new Response(null, { status: 304 });
    const r = await run(env);
    expect(r.status).toBe("unchanged");
    expect((pageRequests[0]!.headers as Record<string, string>)["If-None-Match"]).toBe('"v1"');
    expect(ntfy).toHaveLength(0);
  });

  it("au-delà du maximum, envoie un message de synthèse", async () => {
    const env = makeEnv();
    seed(env, []);
    pageResponse = page(bootWith(["a", "b", "c", "d"].map((s) => bootItem(s))));
    const r = await run(env);
    expect(r.notified).toBe(2);
    expect(ntfy).toHaveLength(3);
    expect(ntfy[2].title).toBe("+2 autres nouveaux modèles");
    expect(JSON.parse(env.STATE.store.get("seen")!)).toHaveLength(4);
  });

  it("échec ntfy : le modèle reste non vu et l'ETag n'est pas mémorisé", async () => {
    const env = makeEnv();
    seed(env, ["a"]);
    ntfyOk = false;
    pageResponse = page(bootWith([bootItem("a"), bootItem("b")]), '"v3"');
    const r = await run(env);
    expect(r.failedNotifications).toBe(1);
    expect(JSON.parse(env.STATE.store.get("seen")!)).toEqual(["a"]);
    expect(env.STATE.store.has("etag")).toBe(false);
  });

  it("page au format inattendu : bascule sur le flux Atom et prévient", async () => {
    const env = makeEnv();
    seed(env, ["nvidia-nemotron-3-5-super-vl"]);
    pageResponse = () => new Response("<html>refonte du site</html>", { status: 200 });
    const r = await run(env);
    expect(r).toMatchObject({ status: "notified", source: "atom", newModels: ["deepseek-v4-1-flash-1017"], alerts: ["degraded"] });
    expect(ntfy.map((b) => b.title)).toEqual(["⚠️ model-release-watch : source principale en échec, flux Atom utilisé", "DeepSeek — DeepSeek V4.1 Flash 1017"]);
    expect(env.STATE.store.has("etag")).toBe(false);
  });

  it("page et flux en échec de format : alerte « format » immédiate", async () => {
    const env = makeEnv();
    seed(env, ["a"]);
    pageResponse = () => new Response("<html></html>", { status: 200 });
    feedResponse = () => new Response("<html></html>", { status: 200 });
    const r = await run(env);
    expect(r.status).toBe("schema-error");
    expect(ntfy[0].title).toContain("format de la source inattendu");
  });

  it("source injoignable : alerte après 3 échecs, une seule fois par 24 h", async () => {
    const env = makeEnv();
    seed(env, ["a"]);
    pageResponse = () => new Response("nope", { status: 503 });
    feedResponse = () => new Response("nope", { status: 503 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await run(env)).status);
    expect(statuses).toEqual(["fetch-error", "fetch-error", "fetch-error", "fetch-error"]);
    expect(ntfy).toHaveLength(1);
    expect(ntfy[0].title).toContain("source injoignable");
  });

  it("alerte si aucun nouveau modèle depuis 72 h", async () => {
    const env = makeEnv();
    seed(env, ["a"]);
    const old = new Date(Date.now() - 80 * 3600 * 1000).toISOString();
    env.STATE.store.set("health", JSON.stringify({ consecutiveFailures: 0, alertsSentAt: {}, lastNewAt: old }));
    pageResponse = page(bootWith([bootItem("a")]));
    const r = await run(env);
    expect(r.alerts).toEqual(["stale"]);
  });

  it("dry run : rien n'est envoyé ni écrit", async () => {
    const env = makeEnv();
    seed(env, ["a"]);
    pageResponse = page(bootWith([bootItem("a"), bootItem("b")]));
    const r = await run(env, { dryRun: true });
    expect(r.messages).toHaveLength(1);
    expect(ntfy).toHaveLength(0);
    expect(JSON.parse(env.STATE.store.get("seen")!)).toEqual(["a"]);
    expect(env.STATE.store.has("health")).toBe(false);
  });

  it("sans NTFY_TOPIC : ne fait rien", async () => {
    const env = makeEnv();
    env.NTFY_TOPIC = "";
    expect((await run(env)).status).toBe("misconfigured");
  });
});
