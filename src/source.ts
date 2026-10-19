/**
 * Lecture des modèles publiés sur ai-tldr.dev.
 *
 * Source principale : la page https://ai-tldr.dev/releases/model/ embarque dans son HTML
 *   <script type="application/json" id="feed-boot">{"manifest":{…},"head":{"cat":"model","items":[…]}}</script>
 * où head.items contient les ~30 derniers modèles (id, title, org, date, importance, explainer.tagline, ent…).
 *
 * Secours : le flux Atom https://ai-tldr.dev/feed.xml (50 dernières entrées, toutes catégories,
 * sans niveau d'importance), filtré sur <category term="model"/>.
 *
 * Aucun de ces formats n'est documenté comme API : toute dérive lève SchemaError.
 */

export type Impact = "seismic" | "major" | "notable" | "unknown";

export interface ModelRelease {
  slug: string;
  name: string;
  vendor: string;
  date: string; // YYYY-MM-DD, ou "" si inconnue
  impact: Impact;
  summary: string;
  url: string; // page ai-tldr.dev de la release
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function normalizeImpact(v: unknown): Impact {
  const s = str(v).toLowerCase();
  return s === "seismic" || s === "major" || s === "notable" ? s : "unknown";
}

const releaseUrl = (siteBase: string, slug: string) =>
  `${siteBase.replace(/\/+$/, "")}/releases/${encodeURIComponent(slug)}/`;

/** « Nemotron 3.5 Super VL — NVIDIA's open… » → nom du modèle (entité liée en priorité). */
function modelName(item: Raw, title: string): string {
  if (Array.isArray(item.ent)) {
    const ent = (item.ent as Raw[]).find((e) => e && e.kind === "model" && str(e.name));
    if (ent) return str(ent.name);
  }
  return title.split(" — ")[0]!.trim() || title;
}

// ---------------------------------------------------------------- feed-boot (HTML)

export function parseFeedBoot(html: string, siteBase: string): ModelRelease[] {
  const m = html.match(/<script[^>]*\bid=["']feed-boot["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new SchemaError("Bloc <script id=\"feed-boot\"> introuvable dans la page");

  let boot: Raw;
  try {
    boot = JSON.parse(m[1]!) as Raw;
  } catch {
    throw new SchemaError("Le bloc feed-boot n'est pas du JSON valide");
  }

  const head = boot.head as Raw | undefined;
  if (!head || !Array.isArray(head.items)) throw new SchemaError("feed-boot : head.items absent");
  const trustCategory = head.cat === "model";

  const out: ModelRelease[] = [];
  const seen = new Set<string>();
  for (const raw of head.items as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Raw;
    const cats = Array.isArray(item.categories) ? (item.categories as unknown[]).map(str) : [];
    if (!trustCategory && !cats.includes("model")) continue;

    const slug = str(item.id);
    const title = str(item.title);
    if (!slug || !title || seen.has(slug)) continue;
    seen.add(slug);

    const explainer = (item.explainer ?? {}) as Raw;
    out.push({
      slug,
      name: modelName(item, title),
      vendor: str(item.org) || str((item.author as Raw | undefined)?.name),
      date: (str(item.date) || str(item.publishDate)).slice(0, 10),
      impact: normalizeImpact(item.importance),
      summary: str(explainer.tagline) || str(item.summary),
      url: releaseUrl(siteBase, slug),
    });
  }

  if (out.length === 0) {
    throw new SchemaError(`feed-boot : ${(head.items as unknown[]).length} entrées mais aucune exploitable (id/title)`);
  }
  return out;
}

// ---------------------------------------------------------------- Atom (secours)

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .trim();
}

const tag = (xml: string, name: string): string => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeXml(m[1]!) : "";
};

export function parseAtom(xml: string, siteBase: string): ModelRelease[] {
  if (!/<feed\b/i.test(xml)) throw new SchemaError("Le flux de secours n'est pas un flux Atom");
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  if (entries.length === 0) throw new SchemaError("Flux Atom vide");

  const out: ModelRelease[] = [];
  for (const e of entries) {
    const terms = [...e.matchAll(/<category\b[^>]*\bterm=["']([^"']+)["']/gi)].map((m) => m[1]);
    if (!terms.includes("model")) continue;

    const id = tag(e, "id");
    const slug = id.match(/\/releases\/([^/]+)\/?$/)?.[1] ?? "";
    const title = tag(e, "title");
    if (!slug || !title) continue;

    out.push({
      slug: decodeURIComponent(slug),
      name: modelName({}, title),
      vendor: tag(e.match(/<author\b[\s\S]*?<\/author>/i)?.[0] ?? "", "name"),
      date: tag(e, "published").slice(0, 10),
      impact: "unknown",
      summary: tag(e, "summary"),
      url: releaseUrl(siteBase, decodeURIComponent(slug)),
    });
  }
  // 0 modèle dans les 50 dernières entrées est possible : ce n'est pas une erreur de format.
  return out;
}
