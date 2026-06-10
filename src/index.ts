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

    // Public demo, no token. Runs one fixed, safe scrape so a website visitor
    // can see a real browser run (and screenshot) without credentials.
    if (url.pathname === "/demo") {
      const demoReq = {
        recipe: {
          url: "https://example.com",
          extract: {
            fields: [
              { name: "heading", selector: "h1" },
              { name: "paragraph", selector: "p" },
            ],
          },
        },
      };
      const result = await runRecipe(env, demoReq);
      await logRun(env, demoReq, result);
      return json(result, result.ok ? 200 : 400);
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
    // Keep the run log bounded for the demo (newest 150 rows).
    const h = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    };
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/wh_runs?select=created_at&order=created_at.desc&offset=150&limit=1`,
      { headers: h },
    );
    const rows = (await r.json()) as { created_at: string }[];
    const cutoff = rows?.[0]?.created_at;
    if (cutoff) {
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/wh_runs?created_at=lt.${encodeURIComponent(cutoff)}`,
        { method: "DELETE", headers: { ...h, prefer: "return=minimal" } },
      );
    }
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2322d3ee'/%3E%3Cpath d='M16 8l2.2 5.8L24 16l-5.8 2.2L16 24l-2.2-5.8L8 16l5.8-2.2z' fill='%2308080a'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${LANDING_CSS}</style></head>
<body><div class="glow"></div><main>
  <header>
    <div class="logo"><span class="mark">✦</span> webhands</div>
    <span class="status"><i></i> ${browserBound ? "browser live" : "dry mode"}</span>
  </header>
  <span class="eyebrow">computer-use</span>
  <h1>No API? <br>Now there's an agent.</h1>
  <p class="lede">Webhands drives the dashboards that have no usable API, TikTok Shop seller center, supplier and 3PL portals, in a real headless browser. It logs in, navigates, returns clean structured data with a screenshot, and refuses any write until you confirm it.</p>
  <div class="card">
    <div class="card-head">Live capture <span class="runtag"><i></i> scanning</span></div>
    <div class="browser">
      <div class="bbar"><span class="bdot"></span><span class="bdot"></span><span class="bdot"></span><span class="burl">seller.example.com/orders</span></div>
      <div class="bbody">
        <div class="brow"></div><div class="brow s"></div><div class="brow"></div><div class="brow s"></div><div class="brow"></div><div class="brow s"></div>
        <div class="scan"></div>
      </div>
    </div>
  </div>
  <div class="card wide">
    <div class="card-head">Run a recipe</div>
    <pre>curl $URL/run \\
  -H "x-webhands-token: &lt;token&gt;" \\
  -H "content-type: application/json" \\
  -d '{"recipe":{"url":"https://seller.example.com/orders",
       "extract":{"prompt":"orders as JSON [{id,total,status}]"}}}'</pre>
  </div>
  <div class="card wide">
    <div class="card-head">Try it live</div>
    <button onclick="wh()">▶ Run a live scrape</button>
    <p class="hint">Drives a real headless browser against example.com and returns the extracted data plus a screenshot of what it saw.</p>
    <pre id="out" class="out"></pre>
    <img id="shot" alt="" />
  </div>
  <footer>Cloudflare Browser Rendering · screenshot proof · confirm-gated writes · <a href="/info">/info</a></footer>
  <script>
    async function wh(){
      var out=document.getElementById('out'), shot=document.getElementById('shot');
      out.textContent='Launching browser and scraping example.com …'; shot.removeAttribute('src');
      try{
        var r=await fetch('/demo',{method:'POST'}); var j=await r.json();
        out.textContent='Extracted: '+JSON.stringify(j.data)+'\\nSteps: '+(j.steps||[]).join(' → ');
        if(j.screenshotBase64){ shot.src='data:image/png;base64,'+j.screenshotBase64; }
      }catch(e){ out.textContent='Error: '+e.message; }
    }
  </script>
</main></body></html>`;
}

const LANDING_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#08080a;color:#ededf2;font:15px/1.65 'Inter',ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 90% 55% at 70% -10%,rgba(6,182,212,.20),transparent 60%),radial-gradient(ellipse 50% 40% at 5% 5%,rgba(34,211,238,.10),transparent 55%)}
main{position:relative;max-width:1000px;margin:0 auto;padding:36px 24px 64px;z-index:1}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:48px}
.logo{display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,#06b6d4,#22d3ee);color:#08080a;font-weight:800}
.status{display:inline-flex;align-items:center;gap:7px;border:1px solid #26262e;background:#111114;border-radius:999px;padding:5px 11px;font-size:11px;color:#8b8b96}
.status i{width:7px;height:7px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950}
.eyebrow{display:inline-block;border:1px solid #26262e;background:#111114;border-radius:999px;padding:4px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#8b8b96}
h1{font-size:56px;line-height:1.02;letter-spacing:-.035em;margin:18px 0 16px;font-weight:800;max-width:800px;background:linear-gradient(120deg,#fff,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{color:#8b8b96;max-width:580px;font-size:16px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:28px}
@media(max-width:640px){.grid{grid-template-columns:1fr}h1{font-size:34px}}
.card{border:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,rgba(17,20,24,.9),rgba(17,17,20,.5));backdrop-filter:blur(12px);border-radius:20px;padding:20px;box-shadow:0 1px 0 0 rgba(255,255,255,.04) inset,0 16px 50px -22px rgba(0,0,0,.7);transition:.2s}.card:hover{border-color:rgba(34,211,238,.35);transform:translateY(-2px)}
.card.wide{margin-top:12px}
.card-head{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#8b8b96;margin-bottom:12px}
.n{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:#08080a;color:#22d3ee;font-weight:700;font-size:13px;margin-bottom:10px}
.t{font-weight:600;margin-bottom:4px;font-size:14px}
.d{color:#8b8b96;font-size:13px}
.mono{font-family:ui-monospace,Menlo,monospace}
pre{background:#08080a;border-radius:12px;padding:14px;overflow-x:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:#8b8b96;line-height:1.6}
footer{margin-top:34px;color:#8b8b96;font-size:12.5px}
a{color:#22d3ee;text-decoration:none}
button{font:inherit;cursor:pointer;border:none;background:linear-gradient(135deg,#06b6d4,#22d3ee);color:#08080a;font-weight:700;border-radius:10px;padding:11px 18px;font-size:14px;transition:.15s}
button:hover{opacity:.9}
.hint{color:#8b8b96;font-size:12.5px;margin:10px 0 0}
.out{min-height:20px;white-space:pre-wrap;margin-top:12px}
.out:empty{display:none}
#shot{display:block;max-width:100%;margin-top:12px;border-radius:10px;border:1px solid #26262e}
#shot:not([src]){display:none}
.runtag{display:inline-flex;align-items:center;gap:6px;font-size:10px;color:#22d3ee;background:rgba(34,211,238,.12);border-radius:999px;padding:2px 8px;margin-left:8px;vertical-align:middle}
.runtag i{width:6px;height:6px;border-radius:50%;background:#22d3ee;animation:blink 1.4s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:.3}50%{opacity:1}}
.flow{position:relative;margin-top:4px}
.ftrack{position:absolute;left:8%;right:8%;top:21px;height:2px;background:#26262e;border-radius:2px;overflow:hidden;display:none}
@media(min-width:640px){.ftrack{display:block}}
.ftrack::before{content:"";position:absolute;top:-1px;height:4px;width:24%;border-radius:4px;background:linear-gradient(90deg,transparent,#22d3ee,transparent);animation:ftravel 2.8s linear infinite}
@keyframes ftravel{0%{left:-24%}100%{left:100%}}
.fnodes{position:relative;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
@media(max-width:640px){.fnodes{grid-template-columns:1fr}}
.fnode{text-align:center}
@media(min-width:640px){.fnode{text-align:left}}
.fico{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,#06b6d4,#22d3ee);color:#08080a;font-weight:700;margin:0 auto 10px;animation:fpulse 2.8s ease-in-out infinite}
@media(min-width:640px){.fico{margin:0 0 10px}}
@keyframes fpulse{0%,100%{box-shadow:0 0 0 0 rgba(34,211,238,0)}50%{box-shadow:0 0 0 6px rgba(34,211,238,.18)}}
.browser{border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;background:#0c0e12}
.bbar{display:flex;align-items:center;gap:6px;padding:9px 12px;background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.06)}
.bdot{width:9px;height:9px;border-radius:50%;background:#3a3f47}
.burl{margin-left:8px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#8b8b96}
.bbody{position:relative;padding:16px;display:flex;flex-direction:column;gap:11px;min-height:176px;overflow:hidden}
.brow{height:11px;border-radius:5px;background:rgba(255,255,255,.07);width:88%}
.brow.s{background:rgba(34,211,238,.22);width:56%}
.scan{position:absolute;left:0;right:0;height:52px;top:-52px;background:linear-gradient(180deg,transparent,rgba(34,211,238,.22),transparent);box-shadow:0 0 18px rgba(34,211,238,.25);animation:scan 3s ease-in-out infinite}
@keyframes scan{0%{top:-52px}100%{top:100%}}
@media (prefers-color-scheme: light){
  body{background:#fafafc;color:#12141b}
  .status,.eyebrow,.card{background:#fff;border-color:#e2e4e9}
  .status,.eyebrow,.lede,.d,footer,pre{color:#5f626e}
  .t{color:#12141b}
  pre,.n{background:#f3f4f6}
  .glow{background:radial-gradient(ellipse 70% 40% at 50% -8%,rgba(79,102,241,.10),transparent 60%)}
}
`;
