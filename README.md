# DecisionMatrix MCP

A transparent, **100% deterministic** [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
server that gives LLM agents a reliable **multi-criteria decision analysis (MCDA)** engine.

Agents are great at gathering options but unreliable at *weighing* them: they lose
precision, apply inconsistent weights, and can't show their work. DecisionMatrix
offloads the scoring to an exact, explainable engine. You provide **options** and
**weighted criteria** (plus a score matrix); it returns a fully **scored, ranked, and
explained** result — with per-criterion breakdowns, the methodology used, the weights
applied, and a plain-language explanation.

Every number flows through [`decimal.js`](https://github.com/MikeMcl/decimal.js) at
40-digit precision (**never floats**), so identical inputs always produce
**byte-identical output**. The server is **stateless** — no database, no sessions.

## 🌐 Live hosted server (free, no install)

A public remote MCP server runs on Cloudflare's edge — point any Streamable-HTTP
MCP client at it:

```
https://decisionmatrix-mcp.pages.dev/mcp
```

```json
{ "mcpServers": { "decisionmatrix": {
    "type": "http", "url": "https://decisionmatrix-mcp.pages.dev/mcp" } } }
```

It runs in **open mode** on the free tier (no key, 15 calls/day per IP). Paid plans
(**Starter $12/mo · 5,000/day**, **Pro $39/mo · 50,000/day**) are live via Stripe
Checkout — buy a plan, get an API key instantly, and send it as `X-API-Key`. Self-host
for unlimited calls with no keys. Landing page + pricing: <https://decisionmatrix-mcp.pages.dev>.

---

## What it does

Six tools, all returning a uniform, agent-parseable envelope:

| Tool | Purpose |
|------|---------|
| `create_decision` | **Main tool.** Rank options against weighted criteria → winner, full ranking, per-criterion breakdowns, methodology, weights, and a plain-language explanation. |
| `score_options` | Return the full normalized scored matrix when scores are supplied separately. |
| `sensitivity_analysis` | Sweep each criterion's weight ±X% and report how robust the winner is (and where it flips). |
| `compare_two` | Head-to-head comparison of exactly two options with per-criterion win counts. |
| `list_methods` | Discovery: available scoring methods and when to use each. |
| `health_check` | Version, status, and capabilities. |

### Scoring methods

| method | model | normalization | notes |
|--------|-------|---------------|-------|
| `weighted_sum` *(default)* | Simple Additive Weighting (SAW) | min-max per criterion | Most transparent; additive contributions. Handles negatives. |
| `weighted_product` | Weighted Product Model (WPM) | ratio (x/max, min/x) | Punishes any single weak criterion; **requires scores > 0**. |
| `topsis` | Closeness to ideal solution | vector (Euclidean) | 0–1 closeness coefficient; robust with many criteria. |

Each criterion has a **direction**: `benefit` (higher is better — quality, speed) or
`cost` (lower is better — price, latency, risk). Weights are **relative**; they are
normalized to sum to 1 internally.

### Consistent response envelope

Every **successful** response contains: `status`, `method`, `winner`, `ranking`
(with per-criterion `breakdown`), `methodology`, `weights_used`, `inputs_used`,
`notes`, and a natural-language `explanation`.

```json
{
  "status": "success",
  "method": "weighted_sum",
  "winner": { "option": "Gamma", "score": 0.666667, "score_exact": "0.666667", "rank": 1, "tie": false, "tied_with": [] },
  "ranking": [
    { "rank": 1, "option": "Gamma", "score": 0.666667, "score_exact": "0.666667",
      "breakdown": [
        { "criterion": "Price", "direction": "cost", "weight": 0.5, "weight_raw": "3",
          "raw_score": "900", "normalized_score": 1, "weighted_contribution": 0.5 }
      ] }
  ],
  "methodology": {
    "method": "weighted_sum",
    "name": "Weighted Sum Model (Simple Additive Weighting)",
    "normalization": "min-max per criterion (best value -> 1, worst -> 0)",
    "score_range": "0 to 1 (higher is better)",
    "weighting": "Criteria weights are normalized to sum to 1; only their relative sizes matter.",
    "deterministic": true
  },
  "weights_used": [ { "criterion": "Price", "direction": "cost", "weight_input": "3", "weight_normalized": 0.5 } ],
  "inputs_used": { "options": ["Alpha","Beta","Gamma"], "method": "weighted_sum", "option_count": 3, "criterion_count": 3 },
  "notes": [ "Scores are normalized within this option set; they express relative standing, not an absolute grade." ],
  "explanation": "Using the Weighted Sum Model, 'Gamma' ranks #1 with a score of 0.666667, ahead of 'Alpha' (0.527778) by 26.32% ..."
}
```

**Errors never cross the tool boundary as exceptions** — they come back as a
structured, actionable envelope:

```json
{
  "status": "error",
  "error": {
    "type": "incomplete_scores",
    "message": "Missing 1 score(s) in the options x criteria matrix.",
    "hint": "Provide a score for every option and criterion. Missing: Beta / Weight."
  }
}
```

> **Design note — exact numbers:** `score` is a deterministically-rounded number (6 dp)
> for easy consumption; `score_exact` / `raw_score` are full-precision **strings** so no
> precision is lost in JSON. Rankings are computed on the exact values, with input order
> as a stable tie-break.

---

## Project structure

```
decisionmatrix-mcp/
├── worker-src/
│   ├── index.mjs        # Cloudflare Pages Function (_worker.js): MCP over Streamable HTTP + billing routes
│   ├── engine.mjs       # The deterministic MCDA engine: 3 methods + 6 tools + validation
│   └── billing.mjs      # Stripe Checkout + KV-backed API keys, quota metering, webhook
├── site/
│   ├── index.html       # Static landing / pricing / docs page
│   └── _worker.js        # Built bundle (esbuild output; git-ignored)
├── tests/
│   └── engine.test.mjs  # 21 core scoring-logic tests (node --test)
├── examples/
│   └── agent_example.mjs # End-to-end MCP client demo over HTTP
├── package.json         # build / deploy / dev / test scripts
├── wrangler.toml        # Cloudflare Pages config
├── .env.example         # Optional auth/rate-limit env reference
├── LICENSE              # MIT
└── README.md
```

**Separation of concerns:** `engine.mjs` is pure and transport-agnostic (import it
directly in tests or any Node/Deno/edge runtime); `index.mjs` only handles the MCP
JSON-RPC wiring, HTTP, CORS, and the auth/metering seam.

---

## Requirements

* Node **18+** (for the build, tests, and local dev). Only two dev/runtime deps:
  `decimal.js` (math) and `esbuild` (bundler).
* A Cloudflare account (free tier is fine) to deploy the hosted version.

---

## Run it locally

```bash
git clone <your-fork> decisionmatrix-mcp && cd decisionmatrix-mcp
npm install

# Run the test suite (no server needed)
npm test

# Serve the MCP endpoint locally via Wrangler (builds + runs Pages dev)
npm run dev          # -> http://127.0.0.1:8788/mcp

# Try the end-to-end client demo (hosted by default, or pass a local URL)
node examples/agent_example.mjs
node examples/agent_example.mjs http://127.0.0.1:8788
```

Quick manual call:

```bash
curl -s http://127.0.0.1:8788/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"list_methods","arguments":{}}}'
```

---

## Client configuration

### Cursor — `~/.cursor/mcp.json`
```json
{ "mcpServers": { "decisionmatrix": {
    "url": "https://decisionmatrix-mcp.pages.dev/mcp" } } }
```

### Claude Desktop — `claude_desktop_config.json`
Claude Desktop launches stdio servers, so bridge to the HTTP endpoint with `mcp-remote`:
```json
{ "mcpServers": { "decisionmatrix": {
    "command": "npx", "args": ["-y", "mcp-remote", "https://decisionmatrix-mcp.pages.dev/mcp"] } } }
```

### VS Code — `.vscode/mcp.json`
```json
{ "servers": { "decisionmatrix": {
    "type": "http", "url": "https://decisionmatrix-mcp.pages.dev/mcp" } } }
```

### Any Streamable-HTTP MCP client
Point it at `https://decisionmatrix-mcp.pages.dev/mcp` (or your self-hosted URL). If
you enable auth, add `X-API-Key` (or `Authorization: Bearer <key>`) in the client's
`headers`.

---

## Tools & parameters

### `create_decision(options, criteria, scores, method="weighted_sum")`
- **options** — array of names (`["Vendor A","Vendor B"]`) or objects
  (`[{"name":"Vendor A","scores":{...}}]`). Minimum 2, names unique.
- **criteria** — array of `{ "name", "weight" (>=0), "direction": "benefit"|"cost" }`.
  At least one weight must be > 0.
- **scores** — the option×criterion matrix. Accepted shapes:
  - object map: `{ "Vendor A": { "Price": 100, "Quality": 8 }, ... }`
  - array: `[ { "option": "Vendor A", "scores": { ... } }, ... ]`
  - inline on each option object.
- **method** — `weighted_sum` (default) · `weighted_product` · `topsis` (aliases like
  `saw`, `wpm`, `ideal` also resolve).

### `score_options(options, criteria, scores, method)`
Same inputs as `create_decision`; returns the full **scored matrix** (per-option,
per-criterion normalized scores + totals) without the winner narrative.

### `sensitivity_analysis(options, criteria, scores, method, variation=0.2, steps=10)`
Sweeps each criterion's weight from `-variation` to `+variation` (fractional, e.g.
`0.2` = ±20%) in `steps` increments (2–100), renormalizing the others, and recomputes
the winner each time. Returns a `robustness_score` (share of scenarios the baseline
winner stays #1), the `fragile_criteria`, and per-criterion flip points.

### `compare_two(option_a, option_b, criteria, scores, method)`
Head-to-head between exactly two options (pass `option_a`/`option_b` names, or a
2-element `options` array). Returns the winner, score `margin`, `criteria_wins`, and a
`per_criterion` breakdown showing which option each criterion `favours`.

### `list_methods()` / `health_check()`
Discovery + status. No parameters.

---

## Example tool-call payloads

Choose a laptop (price & weight are **cost** criteria):
```json
{ "name": "create_decision", "arguments": {
  "options": ["Alpha", "Beta", "Gamma"],
  "criteria": [
    { "name": "Price",   "weight": 3, "direction": "cost" },
    { "name": "Battery", "weight": 2, "direction": "benefit" },
    { "name": "Weight",  "weight": 1, "direction": "cost" }
  ],
  "scores": {
    "Alpha": { "Price": 1000, "Battery": 8,  "Weight": 1.5 },
    "Beta":  { "Price": 1200, "Battery": 12, "Weight": 1.8 },
    "Gamma": { "Price": 900,  "Battery": 6,  "Weight": 1.2 }
  }
} }
```

Test how robust the winner is:
```json
{ "name": "sensitivity_analysis", "arguments": {
  "options": ["Alpha", "Beta", "Gamma"],
  "criteria": [
    { "name": "Price", "weight": 3, "direction": "cost" },
    { "name": "Battery", "weight": 2 }
  ],
  "scores": { "Alpha": {"Price":1000,"Battery":8}, "Beta": {"Price":1200,"Battery":12}, "Gamma": {"Price":900,"Battery":6} },
  "variation": 0.3, "steps": 8
} }
```

Head-to-head:
```json
{ "name": "compare_two", "arguments": {
  "option_a": "Alpha", "option_b": "Beta",
  "criteria": [ { "name": "Price", "weight": 3, "direction": "cost" }, { "name": "Battery", "weight": 2 } ],
  "scores": { "Alpha": {"Price":1000,"Battery":8}, "Beta": {"Price":1200,"Battery":12} }
} }
```

---

## Deploy on Cloudflare Pages

Same pattern as PrecisionCalc — one build step bundles `worker-src/` into
`site/_worker.js` (Pages "advanced mode" Function), then Wrangler deploys the `site/`
directory.

```bash
npm install
npx wrangler login          # once

# Build + deploy in one shot
npm run deploy              # esbuild -> site/_worker.js, then wrangler pages deploy
```

Or wire it to Git: create a Pages project, set the **build command** to `npm run build`
and the **output directory** to `site`. Every push deploys automatically. The
`compatibility_date` and project name live in `wrangler.toml`.

To run **fully free / private**, you need **no bindings, secrets, or env vars** — the
scoring engine is stateless and the server fails open (free tier, quota disabled).

### Enabling billing (already live on the hosted server)

The hosted server uses these — replicate them for your own paid deployment:

1. **KV namespace** for API keys + daily usage counters, bound as `DECISIONMATRIX_KV`
   in `wrangler.toml`.
2. **Stripe products/prices** (subscription) — put the price IDs in `[vars]`
   (`PRICE_STARTER`, `PRICE_PRO`) and the daily limits (`FREE_DAILY`, `STARTER_DAILY`,
   `PRO_DAILY`).
3. **Stripe secrets** (never in the repo):
   ```bash
   wrangler pages secret put STRIPE_SECRET_KEY     --project-name decisionmatrix-mcp
   wrangler pages secret put STRIPE_WEBHOOK_SECRET  --project-name decisionmatrix-mcp
   ```
4. **Webhook** → create a Stripe webhook endpoint at `https://<your-domain>/webhook`
   for `customer.subscription.updated` + `customer.subscription.deleted`.

Routes wired up: `/checkout?plan=starter|pro` → Stripe Checkout, `/success` provisions
and shows the API key (idempotent), `/portal` opens the Stripe billing portal,
`/webhook` handles subscription lifecycle (revoke/restore), `/metrics` reports usage.

---

## Auth & rate limiting

The hosted server enforces tiered quotas in `worker-src/billing.mjs`:

* **Identity** — `identify()` reads `X-API-Key` / `Authorization: Bearer`, looks the key
  up in KV, and falls back to per-IP free tier.
* **Quota** — `consumeQuota()` is a KV daily counter (resets 00:00 UTC); the single
  gating point in `handleRpc` where `method === "tools/call"`.
* **Paywall response** — over-quota / invalid / revoked keys get a structured `upsell`
  envelope with pricing + checkout URLs (agents can read and act on it).
* **Usage metering** — in-memory counters at `/metrics`.

DecisionMatrix has **no paid-only tools** — every tool works on every tier; paid plans
only raise the daily quota. To make a tool paid-only, add its name to `PAID_ONLY_TOOLS`
in `index.mjs`. Because the engine is pure and stateless, none of this touches the
scoring logic.

---

## Design decisions & assumptions

* **Deterministic by construction.** 40-digit decimal math, `ROUND_HALF_UP`
  everywhere, and stable input-order tie-breaking. No floats, no randomness, no clocks
  in the result.
* **Normalization is per-criterion and direction-aware.** `weighted_sum` uses min-max
  (best→1, worst→0); if a criterion is identical across all options it's treated as
  neutral (normalized to 1) and noted. `weighted_product` uses ratio normalization and
  requires strictly positive scores (clear error otherwise). `topsis` uses vector
  normalization and ranks by closeness to the ideal/anti-ideal.
* **Weights are relative** — normalized to sum to 1, so `[3,2,1]` and `[30,20,10]`
  give identical results.
* **Scores are relative to the option set** — they measure standing *within the
  provided alternatives*, not an absolute grade. This is stated in `notes`.
* **Errors are data, not exceptions** — every tool returns `status:"error"` with a
  machine `type` and an actionable `hint`. Validation covers duplicate names, missing
  cells (listing exactly which), non-numeric scores, bad weights/directions, and
  unknown methods.
* **Stateless & side-effect-free** — trivially cacheable, horizontally scalable, and
  safe to run anywhere (Cloudflare, Node, Deno, Bun).

---

## Testing

```bash
npm test          # node --test tests/*.test.mjs  (21 tests, no network)
```

The suite pins the hand-verifiable `weighted_sum` arithmetic, checks determinism,
weight-relativity, direction handling, ties, all three methods, `compare_two`,
`sensitivity_analysis`, the multiple score-input shapes, and every error path.

---

## Roadmap (post-MVP)

1. More methods: AHP (pairwise weight elicitation), ELECTRE, PROMETHEE, Borda count.
2. Group decisions: aggregate multiple stakeholders' weight/score sets.
3. Monte-Carlo sensitivity (perturb all weights jointly) alongside one-at-a-time.
4. Per-key usage dashboard + Redis/Durable-Object quotas for stronger consistency.
5. Published npm package + a hosted multi-tenant tier.

## License

MIT — see [LICENSE](./LICENSE).
