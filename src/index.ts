import type { Env } from "./env";
import type { RunRequest } from "./recipe";
import { runRecipe } from "./browser";

// Webhands: POST a recipe, get structured data back. The agent operates the real
// dashboard UI for tools that have no usable API. Writes require confirm:true.
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return html(landingPage(!!env.BROWSER));
    }
    if (req.method === "GET" && url.pathname === "/info") {
      return json({
        service: "webhands",
        browser: env.BROWSER ? "bound" : "dry-mode",
        usage: "POST /run { recipe, confirm? }",
      });
    }

    if (req.method !== "POST" || url.pathname !== "/run") {
      return json({ error: "POST /run" }, 404);
    }

    if (!checkToken(req, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    let body: RunRequest;
    try {
      body = (await req.json()) as RunRequest;
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    if (!body?.recipe?.url) {
      return json({ error: "recipe.url is required" }, 400);
    }

    const result = await runRecipe(env, body);
    await logRun(env, body, result);
    return json(result, result.ok ? 200 : 400);
  },
};

function checkToken(req: Request, env: Env): boolean {
  const token =
    req.headers.get("x-webhands-token") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  return !!env.WEBHANDS_TOKEN && token === env.WEBHANDS_TOKEN;
}

async function logRun(
  env: Env,
  req: RunRequest,
  result: { ok: boolean; mode: string; error?: string },
): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/wh_runs`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        target_url: req.recipe.url,
        mode: result.mode,
        ok: result.ok,
        error: result.error ?? null,
        confirmed: !!req.confirm,
      }),
    });
  } catch (e) {
    console.error("[webhands] run log failed:", (e as Error).message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function landingPage(browserBound: boolean): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Webhands: computer-use agent for no-API tools</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2336d6c3'/%3E%3Cpath d='M16 8l2.2 5.8L24 16l-5.8 2.2L16 24l-2.2-5.8L8 16l5.8-2.2z' fill='%2308080a'/%3E%3C/svg%3E">
<style>${LANDING_CSS}</style></head>
<body><div class="glow"></div><main>
  <header>
    <div class="logo"><span class="mark">✦</span> webhands</div>
    <span class="status"><i></i> ${browserBound ? "browser live" : "dry mode"}</span>
  </header>
  <span class="eyebrow">computer-use</span>
  <h1>No API? <br>Now there's an agent.</h1>
  <p class="lede">Webhands drives the dashboards that have no usable API, TikTok Shop seller center, supplier and 3PL portals, in a real headless browser. It logs in, navigates, returns clean structured data with a screenshot, and refuses any write until you confirm it.</p>
  <div class="grid">
    <div class="card"><div class="n">1</div><div class="t">Define a recipe</div><div class="d">Entry URL, login + navigation steps, and what to extract (CSS fields or a natural-language ask).</div></div>
    <div class="card"><div class="n">2</div><div class="t">It operates the UI</div><div class="d">A headless browser runs the steps and hands back structured JSON plus a screenshot of what it saw.</div></div>
    <div class="card"><div class="n">3</div><div class="t">Writes are gated</div><div class="d">Any step that mutates state is refused unless the request carries <span class="mono">confirm:true</span>.</div></div>
  </div>
  <div class="card wide">
    <div class="card-head">Run a recipe</div>
    <pre>curl $URL/run \\
  -H "x-webhands-token: &lt;token&gt;" \\
  -H "content-type: application/json" \\
  -d '{"recipe":{"url":"https://seller.example.com/orders",
       "extract":{"prompt":"orders as JSON [{id,total,status}]"}}}'</pre>
  </div>
  <footer>Cloudflare Browser Rendering · screenshot proof · confirm-gated writes · <a href="/info">/info</a></footer>
</main></body></html>`;
}

const LANDING_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#08080a;color:#ededf2;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 70% 40% at 50% -8%,rgba(110,139,255,.16),transparent 60%),radial-gradient(ellipse 50% 30% at 90% 0,rgba(54,214,195,.09),transparent 55%)}
main{position:relative;max-width:760px;margin:0 auto;padding:32px 22px 60px;z-index:1}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:48px}
.logo{display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,#6e8bff,#36d6c3);color:#08080a;font-weight:800}
.status{display:inline-flex;align-items:center;gap:7px;border:1px solid #26262e;background:#111114;border-radius:999px;padding:5px 11px;font-size:11px;color:#8b8b96}
.status i{width:7px;height:7px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950}
.eyebrow{display:inline-block;border:1px solid #26262e;background:#111114;border-radius:999px;padding:4px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#8b8b96}
h1{font-size:38px;line-height:1.1;letter-spacing:-.02em;margin:16px 0 14px;font-weight:650}
.lede{color:#8b8b96;max-width:580px;font-size:16px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:28px}
@media(max-width:640px){.grid{grid-template-columns:1fr}h1{font-size:30px}}
.card{border:1px solid #26262e;background:#111114;border-radius:18px;padding:18px;box-shadow:0 8px 24px -12px rgba(0,0,0,.6)}
.card.wide{margin-top:12px}
.card-head{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#8b8b96;margin-bottom:12px}
.n{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:#08080a;color:#6e8bff;font-weight:700;font-size:13px;margin-bottom:10px}
.t{font-weight:600;margin-bottom:4px;font-size:14px}
.d{color:#8b8b96;font-size:13px}
.mono{font-family:ui-monospace,Menlo,monospace}
pre{background:#08080a;border-radius:12px;padding:14px;overflow-x:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:#8b8b96;line-height:1.6}
footer{margin-top:34px;color:#8b8b96;font-size:12.5px}
a{color:#6e8bff;text-decoration:none}
@media (prefers-color-scheme: light){
  body{background:#fafafc;color:#12141b}
  .status,.eyebrow,.card{background:#fff;border-color:#e2e4e9}
  .status,.eyebrow,.lede,.d,footer,pre{color:#5f626e}
  .t{color:#12141b}
  pre,.n{background:#f3f4f6}
  .glow{background:radial-gradient(ellipse 70% 40% at 50% -8%,rgba(79,102,241,.10),transparent 60%)}
}
`;
