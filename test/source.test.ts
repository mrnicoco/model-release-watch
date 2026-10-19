import { describe, expect, it } from "vitest";
import { normalizeImpact, parseAtom, parseFeedBoot, SchemaError } from "../src/source";
import { releaseMessage } from "../src/notify";
import { ATOM, BOOT, pageWith } from "./helpers";

const SITE = "https://ai-tldr.dev";

describe("parseFeedBoot (données réelles du 19/10/2026)", () => {
  const models = parseFeedBoot(pageWith(BOOT), SITE);

  it("lit tous les modèles du bloc", () => {
    expect(models.map((m) => m.slug)).toEqual([
      "nvidia-nemotron-3-5-super-vl",
      "deepseek-v4-1-flash-1017",
      "black-forest-labs-flux-3-image-klein",
      "meta-muse-spark-open",
    ]);
  });

  it("normalise les champs", () => {
    expect(models[0]).toEqual({
      slug: "nvidia-nemotron-3-5-super-vl",
      name: "Nemotron 3.5 Super VL",
      vendor: "NVIDIA",
      date: "2026-10-15",
      impact: "major",
      summary: "NVIDIA's new open model reads text, documents, charts and short videos in one checkpoint, with only 12B parameters active per token.",
      url: "https://ai-tldr.dev/releases/nvidia-nemotron-3-5-super-vl/",
    });
    expect(models[3]!.impact).toBe("seismic");
  });

  it("déduit le nom du titre quand aucune entité « model » n'est liée", () => {
    expect(models[2]!.name).toBe("FLUX 3 Image Klein");
  });

  it("filtre sur categories si head.cat n'est pas « model »", () => {
    const boot = { head: { cat: "all", items: [{ ...BOOT.head.items[0], categories: ["tool"] }, BOOT.head.items[1]] } };
    expect(parseFeedBoot(pageWith(boot), SITE).map((m) => m.slug)).toEqual(["deepseek-v4-1-flash-1017"]);
  });

  it("lève SchemaError si le bloc est absent, invalide ou vide", () => {
    expect(() => parseFeedBoot("<html></html>", SITE)).toThrow(SchemaError);
    expect(() => parseFeedBoot('<script id="feed-boot" type="application/json">{oops</script>', SITE)).toThrow(SchemaError);
    expect(() => parseFeedBoot(pageWith({ manifest: {} }), SITE)).toThrow(SchemaError);
    expect(() => parseFeedBoot(pageWith({ head: { cat: "model", items: [{ foo: 1 }] } }), SITE)).toThrow(SchemaError);
  });
});

describe("parseAtom (secours)", () => {
  it("ne garde que les entrées de catégorie model et décode les entités", () => {
    const models = parseAtom(ATOM, SITE);
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      slug: "deepseek-v4-1-flash-1017",
      name: "DeepSeek V4.1 Flash 1017",
      vendor: "DeepSeek",
      date: "2026-10-17",
      impact: "unknown",
      summary: "DeepSeek swaps a better-trained checkpoint into deepseek-flash & keeps the same price.",
      url: "https://ai-tldr.dev/releases/deepseek-v4-1-flash-1017/",
    });
  });

  it("les slugs correspondent à ceux de feed-boot (pas de doublon en changeant de source)", () => {
    const boot = new Set(parseFeedBoot(pageWith(BOOT), SITE).map((m) => m.slug));
    for (const m of parseAtom(ATOM, SITE)) expect(boot.has(m.slug)).toBe(true);
  });

  it("lève SchemaError si ce n'est pas un flux Atom", () => {
    expect(() => parseAtom("<html></html>", SITE)).toThrow(SchemaError);
  });
});

describe("normalizeImpact", () => {
  it("reconnaît les 3 niveaux", () => {
    expect(normalizeImpact("seismic")).toBe("seismic");
    expect(normalizeImpact("MAJOR")).toBe("major");
    expect(normalizeImpact(undefined)).toBe("unknown");
  });
});

describe("releaseMessage", () => {
  const base = { slug: "s", name: "N", vendor: "V", date: "2026-10-18", summary: "S", url: "u" };
  it("mappe l'impact sur la priorité ntfy", () => {
    expect(releaseMessage({ ...base, impact: "seismic" }).priority).toBe(5);
    expect(releaseMessage({ ...base, impact: "major" }).priority).toBe(4);
    expect(releaseMessage({ ...base, impact: "notable" }).priority).toBe(3);
    expect(releaseMessage({ ...base, impact: "unknown" }).priority).toBe(3);
  });
  it("compose titre, message et lien", () => {
    expect(releaseMessage({ ...base, impact: "major" })).toEqual({
      title: "V — N",
      message: "S\nmajor · 2026-10-18",
      priority: 4,
      tags: ["star", "major"],
      click: "u",
    });
  });
});
