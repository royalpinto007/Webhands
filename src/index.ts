import type { Env } from "./env";
import type { RunRequest } from "./recipe";
import { runRecipe } from "./browser";

// Webhands: POST a recipe, get structured data back. The agent operates the real
// dashboard UI for tools that have no usable API. Writes require confirm:true.
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
      return html(landingPage(!!env.BROWSER));
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/icon.svg") {
      return svg(WEBHANDS_ICON);
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/info") {
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
  if (!env.GROQ_API_KEY) return json({ error: "AI not configured" }, 503);
  const outputMax = Math.min(Math.max(max ?? 140, 32), 220);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: AI_SYSTEM },
          { role: "user", content: String(prompt).slice(0, 2000) },
        ],
        max_tokens: outputMax,
      }),
    });
    const d = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    return json({ reply: cleanAiReply(d.choices?.[0]?.message?.content), error: d.error?.message });
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
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#060a12"/><path d="M10 6v19l5-4.7 2.7 6.1 3.1-1.4-2.7-6H25z" fill="#58a6ff"/></svg>';

const SPARK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 3v15.5l4.1-3.9 2.2 5 2.6-1.1-2.2-5H18z" fill="currentColor"/></svg>';

const PLAY_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 5.5v13l11-6.5-11-6.5z" fill="currentColor"/></svg>';

const COPY_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

function landingPage(browserBound: boolean): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Webhands: computer-use agent for no-API tools</title>
<meta name="description" content="Webhands puts an AI agent in a real browser for tools with no API. It logs in, navigates, extracts structured data with screenshot proof, and gates writes behind confirmation.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23060a12'/%3E%3Cpath d='M10 6v19l5-4.7 2.7 6.1 3.1-1.4-2.7-6H25z' fill='%2358a6ff'/%3E%3C/svg%3E">
<style>${LANDING_CSS}</style></head>
<body><div class="glow"></div><main>
  <header>
    <div class="logo"><span class="mark">${SPARK_SVG}</span> Webhands</div>
    <span class="status"><i></i> ${browserBound ? "browser live" : "dry mode"}</span>
  </header>
  <section class="hero">
    <div class="hero-copy">
      <span class="eyebrow">computer-use</span>
      <h1>No API? Put an agent <em>in the browser.</em></h1>
      <p class="lede">Webhands drives dashboards that have no usable API, from seller centers to supplier and 3PL portals. It logs in, navigates, returns structured data with screenshot proof, and refuses writes until you confirm.</p>
      <div class="actions">
        <button onclick="wh()">${PLAY_SVG} Run live scrape</button>
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
      <div class="card-head">Run a recipe <button class="copybtn" id="cpb" onclick="cpc()">${COPY_SVG} Copy</button></div>
      <pre id="curl"><span class="c-cmd">curl</span> https://webhands.agentpostmortem.com/run \\
  <span class="c-flag">-H</span> <span class="c-str">"x-webhands-token: &lt;token&gt;"</span> \\
  <span class="c-flag">-H</span> <span class="c-str">"content-type: application/json"</span> \\
  <span class="c-flag">-d</span> <span class="c-str">'{"recipe":{"url":"https://seller.example.com/orders",
       "extract":{"prompt":"orders as JSON [{id,total,status}]"}}}'</span></pre>
    </div>
  </section>
  <div class="card wide">
    <div class="card-head">Try it live</div>
    <button onclick="wh()">${PLAY_SVG} Run a live scrape</button>
    <p class="hint">Drives a real headless browser against example.com and returns the extracted data plus a screenshot of what it saw.</p>
    <pre id="out" class="out"></pre>
    <img id="shot" alt="" />
  </div>
  <section class="suite-block">
    <div class="suite-copy"><span class="card-head">Agent operating suite</span><h2>Webhands is the browser layer.</h2><p>It operates no-API tools. The rest of the suite covers support workflows, MCP tools, evaluation, human approval, and failure lessons.</p></div>
    <div class="suite-links">
      <a class="suite-link" href="https://greenlite.agentpostmortem.com"><span class="suite-mark gm">G</span><span><strong>Greenlite</strong><em>Human approvals</em></span></a>
      <a class="suite-link" href="https://resolvd.agentpostmortem.com"><span class="suite-mark rm">R</span><span><strong>Resolvd</strong><em>Support inbox</em></span></a>
      <a class="suite-link" href="https://tracecase.agentpostmortem.com"><span class="suite-mark tm">T</span><span><strong>Tracecase</strong><em>Agent CI</em></span></a>
      <a class="suite-link" href="https://bridgekit.agentpostmortem.com"><span class="suite-mark bm">B</span><span><strong>Bridgekit</strong><em>MCP tools</em></span></a>
      <a class="suite-link" href="https://agentpostmortem.com"><span class="suite-mark am">A</span><span><strong>AgentPostmortem</strong><em>Failure lessons</em></span></a>
    </div>
  </section>
  <footer>Real browser · screenshot proof · gated writes · <a href="/info">/info</a></footer>
  <script>
    function cpc(){var b=document.getElementById('cpb');var t=document.getElementById('curl').textContent;navigator.clipboard.writeText(t).then(function(){var h=b.innerHTML;b.innerHTML='Copied';setTimeout(function(){b.innerHTML=h;},1400);});}
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
  <button class="chatbtn" aria-label="Open Webhands assistant" onclick="document.getElementById('cbox').classList.toggle('open')"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3a9 9 0 0 0-9 9 9 9 0 0 0 1.3 4.6L3 21l4.6-1.3A9 9 0 1 0 12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
  <div class="chatbox" id="cbox">
    <div class="chathead">Webhands assistant</div>
    <div class="chatmsgs" id="cmsgs"><div class="cm a">Ask me about Webhands, recipes, or how the confirm gate works.</div></div>
    <form class="chatform" onsubmit="return cask(event)"><input id="cin" placeholder="Ask about Webhands…" autocomplete="off"/><button>Send</button></form>
  </div>
</main></body></html>`;
}

const LANDING_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#060a12;--bg2:#0c1220;--ink:#e9eef6;--mut:#9fadc2;--dim:#8294ad;--acc:#58a6ff;--acc2:#8ec2ff;--line:rgba(233,238,246,.09);--line-s:rgba(233,238,246,.17);--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
body{background:var(--bg);color:var(--ink);font:15px/1.65 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:clip}
::selection{background:var(--acc);color:#060a12}
.glow{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 60% 45% at 70% -10%,rgba(88,166,255,.10),transparent 60%),radial-gradient(ellipse 45% 38% at 4% 4%,rgba(88,166,255,.05),transparent 55%)}
main{position:relative;max-width:1320px;margin:0 auto;padding:36px clamp(20px,3.5vw,48px) 72px;z-index:1}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:52px}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:17px;letter-spacing:-.02em}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;border:1px solid var(--line-s);background:var(--bg2);color:var(--acc)}
.status{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:transparent;border-radius:999px;padding:6px 13px;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
.status i{width:6px;height:6px;border-radius:50%;background:#57c584;animation:pg 2.2s infinite}
@keyframes pg{0%{box-shadow:0 0 0 0 rgba(87,197,132,.5)}70%{box-shadow:0 0 0 7px rgba(87,197,132,0)}100%{box-shadow:0 0 0 0 rgba(87,197,132,0)}}
.eyebrow{display:inline-block;font-size:11.5px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--acc)}
h1{font-size:clamp(2.3rem,4.6vw,3.6rem);line-height:1.04;letter-spacing:-.045em;margin:16px 0 18px;font-weight:800;max-width:760px;color:var(--ink)}
h1 em{font-style:normal;font-weight:800;letter-spacing:-.045em;color:var(--acc)}
.lede{color:var(--mut);max-width:610px;font-size:16.5px}
.hero{display:grid;grid-template-columns:minmax(0,1.02fr) minmax(340px,.98fr);gap:22px;align-items:stretch}
.hero-copy{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;min-height:360px;padding:10px 0}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:30px}
.ghost{display:inline-flex;align-items:center;justify-content:center;min-height:43px;border:1px solid var(--line-s);background:transparent;border-radius:999px;padding:10px 20px;color:var(--ink);font-size:13.5px;font-weight:600;transition:all .22s ease}
.ghost:hover{border-color:var(--acc);color:var(--acc2)}
.proof-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:22px}
.mini-card{border:1px solid var(--line);background:var(--bg2);border-radius:16px;padding:18px;transition:border-color .22s ease}
.mini-card:hover{border-color:var(--line-s)}
.mini-card span{display:inline-flex;margin-bottom:12px;color:var(--acc);font-family:var(--mono);font-size:12px;letter-spacing:.12em}
.mini-card strong{display:block;font-size:14px;margin-bottom:5px}
.mini-card p{color:var(--mut);font-size:12.5px;line-height:1.55}
.panel-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.input-row{display:flex;min-width:0;gap:8px;flex-wrap:wrap}
.input-row input{flex:1;min-width:220px;background:var(--bg);border:1px solid var(--line-s);border-radius:999px;padding:9px 15px;color:var(--ink);font:inherit;font-size:13px}
.input-row input:focus{outline:none;border-color:var(--acc)}
.card{min-width:0;max-width:100%;box-sizing:border-box;border:1px solid var(--line);background:var(--bg2);border-radius:18px;padding:22px;transition:border-color .22s ease}
.card:hover{border-color:var(--line-s)}
.card.wide{margin-top:14px}
.panel-grid .card,.hero .card{margin-top:0}
.hero-card{display:flex;min-height:360px;flex-direction:column}
.hero-card .browser{flex:1}
.hero-card .bbody{min-height:260px}
.card-head{display:flex;align-items:center;font-size:11.5px;text-transform:uppercase;letter-spacing:.16em;color:var(--dim);margin-bottom:14px;font-weight:600}
.copybtn{display:inline-flex;align-items:center;gap:6px;margin-left:auto;border:1px solid var(--line-s);background:transparent;color:var(--mut);border-radius:999px;padding:4px 12px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:none;cursor:pointer;transition:all .2s ease}
.copybtn:hover{border-color:var(--acc);color:var(--acc2);opacity:1}
pre{max-width:100%;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:16px;overflow-x:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--mut);line-height:1.7}
.c-cmd{color:var(--acc2)}
.c-flag{color:var(--dim)}
.c-str{color:var(--ink)}
footer{margin-top:44px;border-top:1px solid var(--line);padding-top:22px;color:var(--dim);font-size:12.5px}
footer a{text-decoration:underline;text-underline-offset:3px}
a{color:var(--acc);text-decoration:none;transition:color .2s ease}
a:hover{color:var(--acc2)}
button{display:inline-flex;align-items:center;gap:8px;font:inherit;cursor:pointer;border:1px solid transparent;background:var(--ink);color:#07101d;font-weight:600;border-radius:999px;padding:11px 22px;font-size:13.5px;letter-spacing:.01em;transition:all .22s ease}
button:hover{background:var(--acc2);transform:translateY(-1px)}
.hint{color:var(--mut);font-size:12.5px;margin:12px 0 0}
.out{min-height:20px;white-space:pre-wrap;margin-top:12px}
.out:empty{display:none}
#shot{display:block;max-width:100%;margin-top:12px;border-radius:10px;border:1px solid var(--line-s)}
#shot:not([src]){display:none}
.suite-block{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.25fr);align-items:stretch;gap:16px;margin-top:36px;border-top:1px solid var(--line);padding-top:28px}
.suite-copy{border:1px solid var(--line);background:var(--bg2);border-radius:18px;padding:20px}
.suite-block h2,.suite-copy h2{font-size:19px;line-height:1.35;font-weight:700;letter-spacing:-.02em;color:var(--ink)}
.suite-copy p{color:var(--mut);font-size:12.5px;line-height:1.6;margin-top:8px}
.suite-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.suite-link{display:flex;min-width:0;align-items:center;gap:10px;border:1px solid var(--line);background:var(--bg2);border-radius:14px;padding:12px;color:var(--mut);font-size:11px;font-weight:600;transition:all .2s ease}
.suite-link:hover{border-color:var(--acc);color:var(--ink)}
.suite-mark{display:grid;place-items:center;flex:0 0 auto;width:32px;height:32px;border-radius:10px;border:1px solid var(--line-s);background:var(--bg);color:var(--acc);font-family:var(--mono);font-size:13px;font-weight:700}
.suite-link strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--ink)}
.suite-link em{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:normal;font-size:10.5px;line-height:1.35;color:var(--dim)}
.runtag{display:inline-flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.08em;color:var(--acc2);border:1px solid var(--line-s);border-radius:999px;padding:2px 9px;margin-left:10px;vertical-align:middle}
.runtag i{width:5px;height:5px;border-radius:50%;background:var(--acc);animation:blink 1.4s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:.3}50%{opacity:1}}
.browser{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--bg)}
.bbar{display:flex;align-items:center;gap:6px;padding:9px 12px;background:rgba(233,238,246,.03);border-bottom:1px solid var(--line)}
.bdot{width:8px;height:8px;border-radius:50%;background:rgba(233,238,246,.14)}
.burl{margin-left:8px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--dim)}
.bbody{position:relative;padding:16px;display:flex;flex-direction:column;gap:11px;min-height:176px;overflow:hidden}
.brow{height:11px;border-radius:5px;background:rgba(233,238,246,.06);width:88%}
.brow.s{background:rgba(88,166,255,.28);width:56%}
.scan{position:absolute;left:0;right:0;height:52px;top:-52px;background:linear-gradient(180deg,transparent,rgba(88,166,255,.18),transparent);box-shadow:0 0 18px rgba(88,166,255,.2);animation:scan 3s ease-in-out infinite}
@keyframes scan{0%{top:-52px}100%{top:100%}}
.chatbtn{position:fixed;bottom:20px;right:20px;width:50px;height:50px;border-radius:50%;border:1px solid var(--line-s);cursor:pointer;background:var(--bg2);color:var(--acc);padding:0;display:grid;place-items:center;box-shadow:0 14px 34px -12px rgba(0,0,0,.7);z-index:50;transition:all .2s ease}
.chatbtn:hover{border-color:var(--acc);color:var(--acc2);background:var(--bg2);transform:none}
.chatbox{position:fixed;bottom:82px;right:20px;width:min(92vw,360px);height:440px;display:none;flex-direction:column;background:var(--bg2);border:1px solid var(--line-s);border-radius:18px;overflow:hidden;z-index:50;box-shadow:0 20px 60px -20px rgba(0,0,0,.8)}
.chatbox.open{display:flex}
.chathead{padding:12px 14px;border-bottom:1px solid var(--line);font-weight:700;font-size:13.5px;color:var(--ink)}
.chatmsgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.cm{max-width:82%;padding:8px 11px;border-radius:14px;font-size:13px;line-height:1.5}
.cm.u{align-self:flex-end;background:rgba(88,166,255,.16);color:var(--ink)}
.cm.a{align-self:flex-start;background:rgba(233,238,246,.05)}
.chatform{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}
.chatform input{flex:1;min-width:0;background:var(--bg);border:1px solid var(--line-s);border-radius:999px;padding:8px 13px;color:var(--ink);font:inherit;font-size:13px}
.chatform input:focus{outline:none;border-color:var(--acc)}
.chatform button{border:none;border-radius:999px;padding:0 15px;background:var(--ink);color:#07101d;font-weight:600;cursor:pointer}
.chatform button:hover{background:var(--acc2);transform:none}
@media(max-width:860px){
  main{padding:28px 16px 56px}
  header{margin-bottom:32px}
  .hero{grid-template-columns:1fr;gap:14px}
  .hero-copy,.hero-card{min-height:auto}
  .hero-card .bbody{min-height:190px}
  h1{max-width:none}
  .lede{font-size:15.5px}
  .proof-grid,.panel-grid{grid-template-columns:1fr}
  .suite-block{grid-template-columns:1fr}
  .suite-links{grid-template-columns:repeat(2,minmax(0,1fr))}
  .card,.mini-card{padding:16px;border-radius:16px}
  .input-row input{min-width:0;width:100%}
}
@media(max-width:520px){
  header{align-items:flex-start;gap:12px;flex-direction:column}
  .actions,.actions button,.ghost{width:100%;justify-content:center}
  .ghost{text-align:center}
  .burl{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .input-row{display:grid}
  .input-row input{min-width:0;width:100%;box-sizing:border-box}
  .input-row button{width:100%;justify-content:center}
  .chatbtn{right:14px;bottom:14px}
  .chatbox{right:12px;bottom:74px;width:calc(100vw - 24px);height:min(440px,70vh)}
  .suite-links{grid-template-columns:1fr}
}
`;
