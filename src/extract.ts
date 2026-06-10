import type { Env } from "./env";

// Turn page content into structured JSON. Uses Claude when ANTHROPIC_API_KEY is
// set; otherwise returns the raw text slice so the pipeline still works in dev.
export async function extractWithClaude(
  env: Env,
  pageText: string,
  ask: string,
): Promise<unknown> {
  if (!env.ANTHROPIC_API_KEY) {
    return { _noModel: true, ask, textPreview: pageText.slice(0, 1500) };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system:
        "You extract structured data from page text. Reply with ONLY valid JSON matching the user's request, no prose.",
      messages: [
        {
          role: "user",
          content: `Extraction request: ${ask}\n\nPage text:\n${pageText.slice(0, 12000)}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(stripFences(text));
  } catch {
    return { _unparsed: text };
  }
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}
