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
    if (req.method === "GET" && url.pathname === "/icon.svg") {
      return svg(WEBHANDS_ICON);
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

    if (req.method === "POST" && url.pathname === "/ai") {
      return aiChat(req, env);
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

const AI_SYSTEM =
  "You are the assistant for Webhands, a computer-use agent for tools that have " +
  "no usable API. It drives a real headless browser through a recipe (login, " +
  "navigate, extract), returns structured data plus a screenshot, and refuses " +
  "any write step unless confirm:true is set. Answer questions about Webhands " +
  "and browser automation clearly in at most two complete short sentences. Never " +
  "prefix your answer with assistant or a role label.";

function cleanAiReply(reply?: string): string {
  return (reply ?? "")
    .trim()
    .replace(/^(?:assistant|ai|bot|webhands)\s*:\s*/i, "")
    .trim();
}

function fixedAiReply(prompt: string): string | undefined {
  const question = prompt.trim().toLowerCase().replace(/[?!.,]+$/, "");
  if (/^(hi|hello|hey|hi there|hello there)$/.test(question)) {
    return "Hi! Ask me about Webhands, browser recipes, extraction, or the confirmation gate.";
  }
  if (/^(who are you|what are you|what do you do)$/.test(question)) {
    return "I'm the Webhands assistant. I can explain browser automation, structured extraction, screenshots, and gated writes.";
  }
}

async function aiChat(req: Request, env: Env): Promise<Response> {
  const { prompt, max } = (await req.json().catch(() => ({}))) as { prompt?: string; max?: number };
  if (!prompt) return json({ error: "prompt required" }, 400);
  const fixed = fixedAiReply(prompt);
  if (fixed) return json({ reply: fixed });
  if (!env.AI_GATEWAY_SECRET) return json({ error: "AI not configured" }, 503);
  const outputMax = Math.min(Math.max(max ?? 140, 32), 220);
  try {
    const r = await fetch("https://n8n.agentpostmortem.com/webhook/ai-gw", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ai-secret": env.AI_GATEWAY_SECRET,
      },
      body: JSON.stringify({ system: AI_SYSTEM, prompt: String(prompt).slice(0, 2000), max: outputMax }),
    });
    const d = (await r.json()) as { reply?: string; error?: string };
    return json({ reply: cleanAiReply(d.reply), error: d.error });
  } catch {
    return json({ error: "AI upstream unreachable" }, 502);
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

function svg(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
    },
  });
}

const WEBHANDS_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#22d3ee"/><path d="M16 7.5l2.4 6.1 6.1 2.4-6.1 2.4-2.4 6.1-2.4-6.1L7.5 16l6.1-2.4z" fill="#08080a"/></svg>';

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
    <div class="logo"><span class="mark">✦</span> Webhands</div>
    <span class="status"><i></i> ${browserBound ? "browser live" : "dry mode"}</span>
  </header>
  <section class="hero">
    <div class="hero-copy">
      <span class="eyebrow">computer-use</span>
      <h1>No API? Put an agent in the browser.</h1>
      <p class="lede">Webhands drives dashboards that have no usable API, from seller centers to supplier and 3PL portals. It logs in, navigates, returns structured data with screenshot proof, and refuses writes until you confirm.</p>
      <div class="actions">
        <button onclick="wh()">Run live scrape</button>
        <a class="ghost" href="/info">View runtime info</a>
      </div>
    </div>
    <div class="card hero-card">
      <div class="card-head">Live capture <span class="runtag"><i></i> scanning</span></div>
      <div class="browser">
        <div class="bbar"><span class="bdot"></span><span class="bdot"></span><span class="bdot"></span><span class="burl">seller.example.com/orders</span></div>
        <div class="bbody">
          <div class="brow"></div><div class="brow s"></div><div class="brow"></div><div class="brow s"></div><div class="brow"></div><div class="brow s"></div>
          <div class="scan"></div>
        </div>
      </div>
    </div>
  </section>
  <section class="proof-grid">
    <div class="mini-card"><span>01</span><strong>Real browser runs</strong><p>Operate the exact portal a human would use, with the same screens and flows.</p></div>
    <div class="mini-card"><span>02</span><strong>Structured extraction</strong><p>Turn messy pages into predictable JSON with traceable screenshot evidence.</p></div>
    <div class="mini-card"><span>03</span><strong>Confirmed writes</strong><p>Keep destructive actions behind explicit human approval and clear audit logs.</p></div>
  </section>
  <section class="panel-grid">
    <div class="card wide">
      <div class="card-head">Generate a recipe with AI</div>
      <div class="input-row">
        <input id="rgin" onkeydown="if(event.key==='Enter')rgen()" placeholder="Describe what to scrape, e.g. this week orders"/>
        <button onclick="rgen()">Generate</button>
      </div>
      <pre id="rgout" class="out"></pre>
    </div>
    <div class="card wide">
      <div class="card-head">Run a recipe</div>
      <pre>curl $URL/run \\
  -H "x-webhands-token: &lt;token&gt;" \\
  -H "content-type: application/json" \\
  -d '{"recipe":{"url":"https://seller.example.com/orders",
       "extract":{"prompt":"orders as JSON [{id,total,status}]"}}}'</pre>
    </div>
  </section>
  <div class="card wide">
    <div class="card-head">Try it live</div>
    <button onclick="wh()">▶ Run a live scrape</button>
    <p class="hint">Drives a real headless browser against example.com and returns the extracted data plus a screenshot of what it saw.</p>
    <pre id="out" class="out"></pre>
    <img id="shot" alt="" />
  </div>
  <section class="suite-block">
    <div class="suite-copy"><span class="card-head">Agent operating suite</span><h2>Webhands is the browser layer.</h2><p>It operates no-API tools. The rest of the suite covers support workflows, MCP tools, evaluation, human approval, and failure lessons.</p></div>
    <div class="suite-links">
      <a class="suite-link" href="https://greenlite.aashinyraa.workers.dev"><img src="https://greenlite.aashinyraa.workers.dev/favicon.svg" alt=""><strong>Greenlite</strong><span>Human approvals</span></a>
      <a class="suite-link" href="https://resolvd.aashinyraa.workers.dev"><img src="https://resolvd.aashinyraa.workers.dev/icon.svg" alt=""><strong>Resolvd</strong><span>Support inbox</span></a>
      <a class="suite-link" href="https://tracecase.aashinyraa.workers.dev"><img src="https://tracecase.aashinyraa.workers.dev/icon.svg" alt=""><strong>Tracecase</strong><span>Agent CI</span></a>
      <a class="suite-link" href="https://bridgekit.aashinyraa.workers.dev"><img src="https://bridgekit.aashinyraa.workers.dev/icon.svg" alt=""><strong>Bridgekit</strong><span>MCP tools</span></a>
      <a class="suite-link" href="https://agentpostmortem.com"><img src="https://agentpostmortem.com/icon" alt=""><strong>AgentPostmortem</strong><span>Failure lessons</span></a>
    </div>
  </section>
  <footer>Real browser · screenshot proof · gated writes · <a href="/info">/info</a></footer>
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
    async function rgen(){var i=document.getElementById('rgin'),o=document.getElementById('rgout');var q=i.value.trim()||"this week's orders from the seller dashboard";o.textContent='Generating recipe…';try{var r=await fetch('/ai',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'Output ONLY a Webhands recipe as compact JSON with keys url, steps (array of {action,...}), and extract. No prose, no markdown fences. Task: '+q,max:240})});var d=await r.json();o.textContent=d.reply||('Unavailable ('+(d.error||'?')+')');}catch(e){o.textContent='Error: '+e.message;}}
    async function cask(e){e.preventDefault();var i=document.getElementById('cin'),m=document.getElementById('cmsgs');var q=i.value.trim();if(!q)return false;i.value='';var u=document.createElement('div');u.className='cm u';u.textContent=q;m.appendChild(u);var t=document.createElement('div');t.className='cm a';t.textContent='thinking…';m.appendChild(t);m.scrollTop=m.scrollHeight;try{var r=await fetch('/ai',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:q})});var d=await r.json();t.textContent=d.reply||('Unavailable ('+(d.error||'?')+')');}catch(err){t.textContent='Network error.';}m.scrollTop=m.scrollHeight;return false;}
  </script>
  <button class="chatbtn" onclick="document.getElementById('cbox').classList.toggle('open')">✦</button>
  <div class="chatbox" id="cbox">
    <div class="chathead">Webhands assistant</div>
    <div class="chatmsgs" id="cmsgs"><div class="cm a">Ask me about Webhands, recipes, or how the confirm gate works.</div></div>
    <form class="chatform" onsubmit="return cask(event)"><input id="cin" placeholder="Ask about Webhands…" autocomplete="off"/><button>Send</button></form>
  </div>
</main></body></html>`;
}

const LANDING_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#08080a;color:#ededf2;font:15px/1.65 'Inter',ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:clip}
.glow{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 90% 55% at 70% -10%,rgba(6,182,212,.20),transparent 60%),radial-gradient(ellipse 50% 40% at 5% 5%,rgba(99,102,241,.12),transparent 55%),linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:auto,auto,48px 48px,48px 48px}
main{position:relative;max-width:1120px;margin:0 auto;padding:36px 24px 64px;z-index:1}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:42px}
.logo{display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,#06b6d4,#22d3ee);color:#08080a;font-weight:800}
.status{display:inline-flex;align-items:center;gap:7px;border:1px solid #26262e;background:#111114;border-radius:999px;padding:5px 11px;font-size:11px;color:#8b8b96}
.status i{width:7px;height:7px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950}
.eyebrow{display:inline-block;border:1px solid #26262e;background:#111114;border-radius:999px;padding:4px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#8b8b96}
h1{font-size:56px;line-height:1.02;letter-spacing:-.035em;margin:18px 0 16px;font-weight:800;max-width:760px;background:linear-gradient(120deg,#fff,#a5f3fc 55%,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{color:#9aa0ad;max-width:610px;font-size:16.5px}
.hero{display:grid;grid-template-columns:minmax(0,1.02fr) minmax(340px,.98fr);gap:22px;align-items:stretch}
.hero-copy{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;min-height:360px;padding:10px 0}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:24px}
.ghost{display:inline-flex;align-items:center;justify-content:center;min-height:43px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.035);border-radius:10px;padding:9px 14px;color:#ededf2;font-size:13px;font-weight:700}
.proof-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px}
.mini-card{border:1px solid rgba(255,255,255,.075);background:rgba(255,255,255,.035);border-radius:16px;padding:16px}
.mini-card span{display:inline-flex;margin-bottom:10px;color:#22d3ee;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.mini-card strong{display:block;font-size:14px;margin-bottom:5px}
.mini-card p{color:#9aa0ad;font-size:12.5px;line-height:1.5}
.panel-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.input-row{display:flex;gap:8px;flex-wrap:wrap}
.input-row input{flex:1;min-width:220px;background:#08080a;border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:9px 11px;color:#ededf2;font:inherit;font-size:13px}
.card{border:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,rgba(17,20,24,.9),rgba(17,17,20,.5));backdrop-filter:blur(12px);border-radius:20px;padding:20px;box-shadow:0 1px 0 0 rgba(255,255,255,.04) inset,0 16px 50px -22px rgba(0,0,0,.7);transition:.2s}.card:hover{border-color:rgba(34,211,238,.35);transform:translateY(-2px)}
.card.wide{margin-top:12px}
.panel-grid .card,.hero .card{margin-top:0}
.hero-card{display:flex;min-height:360px;flex-direction:column}
.hero-card .browser{flex:1}
.hero-card .bbody{min-height:260px}
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
.suite-block{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);align-items:stretch;gap:16px;margin-top:24px;border-top:1px solid rgba(255,255,255,.08);padding-top:22px}
.suite-copy{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);border-radius:16px;padding:16px}
.suite-block h2{font-size:17px;line-height:1.35}
.suite-copy p{color:#9aa0ad;font-size:12.5px;line-height:1.55;margin-top:8px}
.suite-links{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}
.suite-link{display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:6px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.035);border-radius:12px;padding:10px;color:#9aa0ad;font-size:11px;font-weight:600;transition:.15s}
.suite-link:hover{border-color:rgba(34,211,238,.4);color:#ededf2}
.suite-link img{width:20px;height:20px;border-radius:6px;object-fit:cover}
.suite-link strong{font-size:12px;color:#ededf2}
.suite-link span{font-size:10.5px;line-height:1.3;color:#8b8b96}
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
.chatbtn{position:fixed;bottom:20px;right:20px;width:50px;height:50px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#06b6d4,#22d3ee);color:#08080a;font-size:20px;box-shadow:0 10px 30px -8px rgba(34,211,238,.5);z-index:50}
.chatbox{position:fixed;bottom:82px;right:20px;width:min(92vw,360px);height:440px;display:none;flex-direction:column;background:#0d1417;border:1px solid rgba(255,255,255,.1);border-radius:18px;overflow:hidden;z-index:50;box-shadow:0 20px 60px -20px rgba(0,0,0,.8)}
.chatbox.open{display:flex}
.chathead{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08);font-size:13px;font-weight:600}
.chatmsgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.cm{max-width:82%;padding:8px 11px;border-radius:14px;font-size:13px;line-height:1.5}
.cm.u{align-self:flex-end;background:rgba(34,211,238,.18)}
.cm.a{align-self:flex-start;background:rgba(255,255,255,.05)}
.chatform{display:flex;gap:8px;padding:10px;border-top:1px solid rgba(255,255,255,.08)}
.chatform input{flex:1;min-width:0;background:#08080a;border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:8px 10px;color:#ededf2;font:inherit;font-size:13px}
.chatform button{border:none;border-radius:9px;padding:0 13px;background:linear-gradient(135deg,#06b6d4,#22d3ee);color:#08080a;font-weight:700;cursor:pointer}
@media(max-width:860px){
  main{padding:28px 16px 56px}
  header{margin-bottom:30px}
  .hero{grid-template-columns:1fr;gap:14px}
  .hero-copy,.hero-card{min-height:auto}
  .hero-card .bbody{min-height:190px}
  h1{font-size:42px;max-width:none}
  .lede{font-size:15.5px}
  .proof-grid,.panel-grid{grid-template-columns:1fr}
  .suite-block{grid-template-columns:1fr}
  .suite-links{grid-template-columns:repeat(2,minmax(0,1fr))}
  .card,.mini-card{padding:16px;border-radius:16px}
  .input-row input{min-width:0;width:100%}
}
@media(max-width:520px){
  header{align-items:flex-start;gap:12px;flex-direction:column}
  h1{font-size:34px}
  .actions,.actions button,.ghost{width:100%}
  .ghost{text-align:center}
  .burl{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chatbtn{right:14px;bottom:14px}
  .chatbox{right:12px;bottom:74px;width:calc(100vw - 24px);height:min(440px,70vh)}
}
@media (prefers-color-scheme: light){
  body{background:#fafafc;color:#12141b}
  .status,.eyebrow,.card{background:#fff;border-color:#e2e4e9}
  .status,.eyebrow,.lede,.d,footer,pre{color:#5f626e}
  .t{color:#12141b}
  pre,.n{background:#f3f4f6}
  .glow{background:radial-gradient(ellipse 70% 40% at 50% -8%,rgba(79,102,241,.10),transparent 60%)}
}
`;
