// Extraits réels de https://ai-tldr.dev/releases/model/ et /feed.xml (19/10/2026), allégés.
import bootJson from "./fixtures/boot.json?raw";
import atomXml from "./fixtures/feed.xml?raw";

export const BOOT = JSON.parse(bootJson) as { head: { cat: string; items: Record<string, unknown>[] } };
export const ATOM: string = atomXml;

/** Page HTML minimale embarquant un bloc feed-boot, comme https://ai-tldr.dev/releases/model/ */
export function pageWith(boot: unknown): string {
  return `<!doctype html><html><head><title>New AI Model Releases | AI/TLDR</title></head><body>
<main id="root"></main>
<script type="application/ld+json">{"@type":"CollectionPage"}</script>
<script type="application/json" id="feed-boot">${JSON.stringify(boot)}</script>
</body></html>`;
}

/** Item feed-boot de type modèle, pour composer des scénarios. */
export function bootItem(id: string, importance = "notable", date = "2026-10-10") {
  return {
    id,
    title: `${id.toUpperCase()} — un modèle de test`,
    org: "Lab",
    date,
    importance,
    categories: ["model"],
    explainer: { tagline: `Tagline ${id}` },
    summary: `Résumé ${id}`,
  };
}

export const bootWith = (items: unknown[]) => ({ manifest: { total: items.length }, head: { cat: "model", items } });
