import { readHealth, run, type Env } from "./watch";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

async function authorized(req: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const given = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(token)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      run(env).then((r) => console.log("run", JSON.stringify(r))),
    );
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      const h = await readHealth(env.STATE);
      // 503 si aucune lecture réussie depuis 12 h : utilisable par un moniteur externe.
      const ok = !!h.lastSuccessAt && Date.now() - Date.parse(h.lastSuccessAt) < 12 * 3600 * 1000;
      return json({ ok, ...h }, ok ? 200 : 503);
    }

    if (url.pathname === "/run" && req.method === "POST") {
      if (!(await authorized(req, env.RUN_TOKEN))) return json({ error: "unauthorized" }, 401);
      const dryRun = url.searchParams.get("dry") === "1";
      return json(await run(env, { dryRun }));
    }

    return json({ service: "model-release-watch", endpoints: ["GET /health", "POST /run[?dry=1]"] }, 404);
  },
} satisfies ExportedHandler<Env>;
