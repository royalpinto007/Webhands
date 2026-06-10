import type { Env } from "./env";
import type { RunRequest } from "./recipe";
import { runRecipe } from "./browser";

// Webhands: POST a recipe, get structured data back. The agent operates the real
// dashboard UI for tools that have no usable API. Writes require confirm:true.
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
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
