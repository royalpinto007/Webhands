# Webhands

A computer-use agent for the tools that have **no usable API**. Webhands drives
the real dashboard (TikTok Shop seller center, supplier/3PL portals) via
Cloudflare Browser Rendering, returns clean structured data, and refuses any
write action unless you explicitly confirm it.

"There's no API" becomes "there's an agent."

## How it works

You POST a **recipe**: an entry URL, optional login/navigation steps, and an
extraction spec. Webhands runs it in a headless browser and returns:

- `data` — structured JSON (scraped from CSS selectors, or extracted from the
  page text by Claude when you give a natural-language `extract.prompt`)
- `screenshotBase64` — proof of what it saw
- `steps` — the actions it took

Any step marked `write: true` (e.g. clicking "Issue refund") is **refused unless
the request includes `confirm: true`**, so reads are safe by default and writes
are deliberate.

## Modes

- **live** — when the `BROWSER` binding is present (Workers plan with Browser
  Rendering enabled).
- **dry** — without the binding, returns the plan it *would* run. Lets you build
  and test recipes without a paid binding.

## Run

```bash
npm install
cp .dev.vars.example .dev.vars   # set WEBHANDS_TOKEN, optional ANTHROPIC_API_KEY
npm run dev
npm run deploy                   # Cloudflare Workers (workers.dev URL)
```

## Example: pull this week's orders from a no-API dashboard

```bash
curl -s "$URL/run" -H "x-webhands-token: $WEBHANDS_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "recipe": {
      "url": "https://seller.example.com/login",
      "steps": [
        { "action": "type", "selector": "#email", "text": "ops@brand.com" },
        { "action": "type", "selector": "#password", "text": "...", "secret": true },
        { "action": "click", "selector": "#signin" },
        { "action": "waitFor", "selector": ".orders-table" },
        { "action": "goto", "url": "https://seller.example.com/orders?range=7d" }
      ],
      "extract": { "prompt": "Return JSON: [{orderId, total, status, date}] for every order row" }
    }
  }'
```

A write recipe (e.g. clicking a "confirm shipment" button) returns an error
until you resend it with `"confirm": true`.
