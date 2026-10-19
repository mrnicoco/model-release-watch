import type { Impact, ModelRelease } from "./source";

export interface NtfyMessage {
  title: string;
  message: string;
  priority: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  click?: string;
}

const PRIORITY: Record<Impact, NtfyMessage["priority"]> = {
  seismic: 5,
  major: 4,
  notable: 3,
  unknown: 3,
};

// Les tags ntfy qui correspondent à un nom d'emoji sont affichés comme emoji.
const EMOJI: Record<Impact, string> = {
  seismic: "rotating_light",
  major: "star",
  notable: "robot",
  unknown: "robot",
};

export function releaseMessage(r: ModelRelease): NtfyMessage {
  const title = r.vendor ? `${r.vendor} — ${r.name}` : r.name;
  const meta = [r.impact !== "unknown" ? r.impact : "", r.date].filter(Boolean).join(" · ");
  const message = [r.summary, meta].filter(Boolean).join("\n") || "Nouveau modèle publié";
  const tags = [EMOJI[r.impact]];
  if (r.impact !== "unknown") tags.push(r.impact);
  return { title, message, priority: PRIORITY[r.impact], tags, click: r.url };
}

/**
 * Publication au format JSON (gère l'UTF-8 dans le titre, contrairement aux en-têtes HTTP).
 * https://docs.ntfy.sh/publish/#publish-as-json
 */
export async function sendNtfy(server: string, topic: string, msg: NtfyMessage): Promise<void> {
  const res = await fetch(server.replace(/\/+$/, "") + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, ...msg }),
  });
  if (!res.ok) {
    throw new Error(`ntfy a répondu ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
