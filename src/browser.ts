import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./env";
import type { Recipe, RunRequest } from "./recipe";
import { hasWriteStep } from "./recipe";
import { extractWithClaude } from "./extract";

export interface RunResult {
  ok: boolean;
  mode: "live" | "dry";
  data?: unknown;
  screenshotBase64?: string;
  steps: string[];
  error?: string;
}

// Execute a recipe. When the BROWSER binding is present we drive a real headless
// browser; otherwise we return a labelled dry result so the service is testable
// without Browser Rendering enabled.
export async function runRecipe(
  env: Env,
  req: RunRequest,
): Promise<RunResult> {
  const { recipe, confirm } = req;

  // Refuse write recipes unless explicitly confirmed.
  if (hasWriteStep(recipe) && !confirm) {
    return {
      ok: false,
      mode: env.BROWSER ? "live" : "dry",
      steps: [],
      error:
        "recipe contains a write step; resend with confirm:true to execute",
    };
  }

  if (!env.BROWSER) {
    return dryRun(recipe);
  }

  const log: string[] = [];
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
  } catch (e) {
    // Browser Rendering not provisioned / over quota — degrade instead of crash.
    return {
      ok: false,
      mode: "live",
      steps: [],
      error: `browser unavailable: ${(e as Error).message}`,
    };
  }
  try {
    const page = await browser.newPage();
    await page.goto(recipe.url, { waitUntil: "networkidle0" });
    log.push(`goto ${recipe.url}`);

    for (const step of recipe.steps ?? []) {
      switch (step.action) {
        case "goto":
          await page.goto(step.url, { waitUntil: "networkidle0" });
          log.push(`goto ${step.url}`);
          break;
        case "type":
          await page.type(step.selector, step.text);
          log.push(`type into ${step.selector}${step.secret ? " (secret)" : ""}`);
          break;
        case "click":
          await page.click(step.selector);
          log.push(`click ${step.selector}${step.write ? " (write)" : ""}`);
          break;
        case "waitFor":
          await page.waitForSelector(step.selector, {
            timeout: step.timeoutMs ?? 15000,
          });
          log.push(`waitFor ${step.selector}`);
          break;
      }
    }

    let data: unknown = undefined;
    if (recipe.extract?.fields?.length) {
      data = await scrapeFields(page, recipe.extract.fields);
      log.push(`scraped ${recipe.extract.fields.length} field(s)`);
    } else if (recipe.extract?.prompt) {
      const text = await page.evaluate(() => document.body.innerText);
      data = await extractWithClaude(env, text, recipe.extract.prompt);
      log.push("extracted via Claude");
    }

    const shot = (await page.screenshot({ encoding: "base64" })) as string;

    return { ok: true, mode: "live", data, screenshotBase64: shot, steps: log };
  } catch (e) {
    return {
      ok: false,
      mode: "live",
      steps: log,
      error: (e as Error).message,
    };
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeFields(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>,
  fields: NonNullable<Recipe["extract"]>["fields"],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const f of fields ?? []) {
    out[f.name] = await page.evaluate(
      (sel: string, attr: string | undefined) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return attr ? el.getAttribute(attr) : (el.textContent ?? "").trim();
      },
      f.selector,
      f.attr,
    );
  }
  return out;
}

function dryRun(recipe: Recipe): RunResult {
  const steps = [
    `goto ${recipe.url}`,
    ...(recipe.steps ?? []).map((s) =>
      s.action === "goto" ? `goto ${s.url}` : `${s.action} ${"selector" in s ? s.selector : ""}`,
    ),
  ];
  return {
    ok: true,
    mode: "dry",
    steps,
    data: {
      _dryRun: true,
      note: "Browser Rendering not bound; this is the plan, not a live result.",
      wouldExtract: recipe.extract ?? null,
    },
  };
}
