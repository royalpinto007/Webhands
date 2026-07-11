import type { BrowserWorker } from "@cloudflare/puppeteer";

export interface Env {
  BROWSER?: BrowserWorker; // Cloudflare Browser Rendering binding
  WEBHANDS_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  GROQ_API_KEY?: string;
}
