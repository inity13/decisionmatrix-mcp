// DecisionMatrix MCP — Cloudflare Pages Function (_worker.js advanced mode).
//
// Serves a live remote MCP server over Streamable HTTP at /mcp with tiered
// metering + Stripe billing, a /checkout + /success + /portal + /webhook flow,
// a usage endpoint at /metrics, and the static landing site for all other paths.
//
// The decision engine itself is 100% stateless and deterministic. Billing/quota
// state lives only in Cloudflare KV (env.DECISIONMATRIX_KV) and never affects the
// scoring math — identical inputs always produce identical results.
//
// If no KV namespace is bound (self-host / local dev), the server "fails open":
// every request is treated as the free tier with quota disabled. To run a fully
// private self-hosted copy, simply don't bind KV and don't set Stripe secrets.
import * as T from "./engine.mjs";
import { DecisionError, errEnvelope } from "./engine.mjs";
import * as B from "./billing.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "DecisionMatrix", version: "1.0.0-edge" };

// Reusable JSON-schema fragments.
const str = { type: "string" };
const num = { type: "number" };
const criteriaSchema = {
  type: "array",
  description: "Weighted criteria. Each: {name, weight (relative, >=0), direction: 'benefit' (higher better, default) | 'cost' (lower better)}.",
  items: {
    type: "object",
    properties: { name: str, weight: num, direction: { type: "string", enum: ["benefit", "cost"], default: "benefit" } },
    required: ["name", "weight"],
  },
};
const scoresSchema = {
  description: "Score matrix. Object form: {\"Option A\": {\"Criterion 1\": 8, ...}, ...}. Array form: [{\"option\":\"Option A\",\"scores\":{...}}]. Or inline scores on each option object.",
  type: "object",
};
const optionsSchema = {
  type: "array",
  description: "Named alternatives. Strings [\"A\",\"B\"] or objects [{\"name\":\"A\",\"scores\":{...}}].",
  items: { type: ["string", "object"] },
};
const methodSchema = { type: "string", enum: ["weighted_sum", "weighted_product", "topsis"], default: "weighted_sum" };

const TOOLS = {
  create_decision: {
    description:
      "Rank named options against weighted criteria and return the winner, full ranking, per-criterion score breakdowns, methodology, the weights used, and a plain-language explanation. This is the main tool. Provide options, criteria [{name, weight, direction}], and a scores matrix. method defaults to weighted_sum (also: weighted_product, topsis). 100% deterministic.",
    inputSchema: { type: "object", properties: { options: optionsSchema, criteria: criteriaSchema, scores: scoresSchema, method: methodSchema }, required: ["options", "criteria", "scores"] },
    handler: (a) => T.create_decision(a),
  },
  score_options: {
    description:
      "Score options against criteria when the score matrix is supplied separately. Returns the full normalized scored matrix (per-option, per-criterion) plus a ranking, without the narrative winner explanation. Use create_decision if you want a winner + explanation.",
    inputSchema: { type: "object", properties: { options: optionsSchema, criteria: criteriaSchema, scores: scoresSchema, method: methodSchema }, required: ["options", "criteria", "scores"] },
    handler: (a) => T.score_options(a),
  },
  sensitivity_analysis: {
    description:
      "Test how robust the winner is to changes in criteria weights. Sweeps each criterion's weight +/- 'variation' (default 0.2 = 20%) over 'steps' (default 10) increments, recomputes the ranking, and reports a robustness score, which criteria are most likely to flip the result, and the flip points.",
    inputSchema: {
      type: "object",
      properties: {
        options: optionsSchema, criteria: criteriaSchema, scores: scoresSchema, method: methodSchema,
        variation: { type: "number", default: 0.2, description: "Fractional weight sweep, 0<v<=1. 0.2 = +/-20%." },
        steps: { type: "integer", default: 10, description: "Number of weight steps per criterion (2-100)." },
      },
      required: ["options", "criteria", "scores"],
    },
    handler: (a) => T.sensitivity_analysis(a),
  },
  compare_two: {
    description:
      "Direct head-to-head comparison of exactly two options. Returns the winner, the score margin, how many criteria each option wins, and a per-criterion breakdown of who each criterion favours. Pass option_a and option_b (names) or a 2-element options array, plus criteria and scores.",
    inputSchema: { type: "object", properties: { option_a: str, option_b: str, options: optionsSchema, criteria: criteriaSchema, scores: scoresSchema, method: methodSchema }, required: ["criteria", "scores"] },
    handler: (a) => T.compare_two(a),
  },
  list_methods: {
    description: "List the available scoring methods (weighted_sum, weighted_product, topsis) with descriptions, normalization details, score ranges, and when to use each. No parameters.",
    inputSchema: { type: "object", properties: {} },
    handler: () => T.list_methods(),
  },
  health_check: {
    description: "Server health, version, and capabilities. No parameters.",
    inputSchema: { type: "object", properties: {} },
    handler: () => T.health_check(),
  },
};

// DecisionMatrix has no paid-only tools; paid plans only raise the daily quota.
// To make a tool paid-only, add its name here and gate on ctx.plan === "free".
const PAID_ONLY_TOOLS = new Set();

// Dispatch one tool with uniform error handling — exceptions never escape.
async function runTool(name, args) {
  const spec = TOOLS[name];
  if (!spec) return errEnvelope(`Unknown tool '${name}'.`, "unknown_tool", `Available: ${Object.keys(TOOLS).join(", ")}.`);
  try { return await spec.handler(args || {}); }
  catch (e) {
    if (e instanceof DecisionError) return errEnvelope(e.message, e.type, e.hint);
    return errEnvelope(`Unexpected error: ${e.message}`, "internal_error", "Verify the shape/types of your inputs against the tool schema.");
  }
}

const meter = { total: 0, rejected: 0, byTool: {}, started: 0 };

// ---- JSON-RPC with metering/gating context ---------------------------------
async function handleRpc(msg, ctx, env) {
  const { id, method, params } = msg;
  if (method === "initialize")
    return reply(id, { protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  if (method === "notifications/initialized") return null;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list")
    return reply(id, { tools: Object.entries(TOOLS).map(([name, s]) => ({ name, description: s.description, inputSchema: s.inputSchema })) });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!TOOLS[name]) return rpcError(id, -32602, `Unknown tool '${name}'.`);

    // Auth-state gating (revoked / invalid keys).
    if (ctx.plan === "revoked" || ctx.plan === "invalid_key") {
      meter.rejected++;
      return toolResult(id, B.upsell(env, ctx.plan, { tool: name }));
    }
    // Paid-only tool gating on the free tier (none by default).
    if (ctx.plan === "free" && PAID_ONLY_TOOLS.has(name)) {
      meter.rejected++;
      return toolResult(id, B.upsell(env, "upgrade_required", { tool: name }));
    }
    // Quota.
    const q = await B.consumeQuota(env, ctx.identity, ctx.limit);
    if (!q.allowed) {
      meter.rejected++;
      return toolResult(id, B.upsell(env, "quota_exceeded", { tool: name, usage: { plan: ctx.plan, used: q.used, limit: q.limit, remaining: 0, resets: "daily 00:00 UTC" } }));
    }
    meter.total++; meter.byTool[name] = (meter.byTool[name] || 0) + 1;
    const result = await runTool(name, args);
    if (result && typeof result === "object") result.quota = { plan: ctx.plan, used: q.used, limit: q.limit, remaining: q.remaining };
    return toolResult(id, result);
  }
  if (typeof id === "undefined" || id === null) return null; // notification
  return rpcError(id, -32601, `Method not found: ${method}`);
}
function reply(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function toolResult(id, obj) {
  return reply(id, { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj, isError: obj?.status === "error" });
}

// ---- HTTP ------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, x-api-key, mcp-session-id, mcp-protocol-version, accept",
  "Access-Control-Expose-Headers": "mcp-session-id",
};
function sse(obj, extra = {}) {
  return new Response(`event: message\ndata: ${JSON.stringify(obj)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "mcp-session-id": "decisionmatrix-stateless", ...CORS, ...extra },
  });
}
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
function redirect(url) { return new Response(null, { status: 302, headers: { Location: url, ...CORS } }); }
function html(body, status = 200) { return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } }); }

function successPage(key, plan, reused) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DecisionMatrix — your API key</title><style>
body{margin:0;background:#0b0f1a;color:#e7ecf5;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Arial;line-height:1.6}
.wrap{max-width:680px;margin:0 auto;padding:56px 20px}a{color:#63a4ff}
.k{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0e1424;border:1px solid #20293f;border-radius:12px;padding:16px;font-size:16px;word-break:break-all;color:#7ae0c6}
.btn{cursor:pointer;background:#7ae0c6;color:#06231a;font-weight:700;border:0;border-radius:9px;padding:9px 14px;margin-top:12px}
pre{background:#0e1424;border:1px solid #20293f;border-radius:12px;padding:14px;overflow:auto;font-size:13px;color:#d7e2ff}
.badge{display:inline-block;color:#7ae0c6;border:1px solid #20293f;border-radius:999px;padding:4px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.1em}
</style></head><body><div class="wrap">
<span class="badge">Payment successful · ${plan} plan</span>
<h1>🎉 Your DecisionMatrix API key</h1>
<p>Save this now — it's shown once. Send it as the <code>X-API-Key</code> header (or <code>Authorization: Bearer</code>).</p>
<div class="k" id="key">${key}</div>
<button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('key').innerText);this.textContent='Copied ✓'">Copy key</button>
${reused ? '<p style="color:#ffcf6b">(This session was already provisioned; same key returned.)</p>' : ""}
<h3>Use it</h3>
<pre>{
  "mcpServers": {
    "decisionmatrix": {
      "url": "https://decisionmatrix-mcp.pages.dev/mcp",
      "headers": { "X-API-Key": "${key}" }
    }
  }
}</pre>
<p><a href="/#pricing">← Back to DecisionMatrix</a> · <a href="/portal?key=${key}">Manage billing</a></p>
</div></body></html>`;
}

export default {
  async fetch(request, env) {
    if (!meter.started) meter.started = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Google Search Console site verification. Served directly (HTTP 200, no
    // extension-stripping redirect) so Google's file check passes at the exact URL.
    if (path === "/googledce1e0dc1be5381e.html")
      return new Response("google-site-verification: googledce1e0dc1be5381e.html", {
        status: 200, headers: { "Content-Type": "text/html; charset=utf-8" },
      });

    // ---- Billing routes ----
    if (path === "/checkout") {
      const plan = (url.searchParams.get("plan") || "starter").toLowerCase();
      if (plan !== "starter" && plan !== "pro") return html("<p>Unknown plan. <a href='/#pricing'>See pricing</a>.</p>", 400);
      try { return redirect(await B.createCheckout(env, plan)); }
      catch (e) { return html(`<p>Checkout error: ${e.message}. <a href="/#pricing">Back</a></p>`, 500); }
    }
    if (path === "/success") {
      const sid = url.searchParams.get("session_id");
      if (!sid) return html("<p>Missing session id. <a href='/#pricing'>Back</a></p>", 400);
      try { const p = await B.provisionFromSession(env, sid); return html(successPage(p.key, p.plan, p.reused)); }
      catch (e) { return html(`<p>Could not verify payment yet: ${e.message}. If you just paid, refresh in a moment. <a href="/#pricing">Back</a></p>`, 402); }
    }
    if (path === "/portal") {
      const key = url.searchParams.get("key") || request.headers.get("x-api-key");
      try { return redirect(await B.createPortal(env, key)); }
      catch (e) { return html(`<p>${e.message} <a href="/#pricing">Back</a></p>`, 400); }
    }
    if (path === "/webhook") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const payload = await request.text();
      const ok = await B.verifyStripeSignature(env, payload, request.headers.get("stripe-signature"));
      if (!ok) return json({ error: "invalid signature" }, 400);
      try { await B.handleWebhookEvent(env, JSON.parse(payload)); } catch (_) {}
      return json({ received: true });
    }

    if (path === "/metrics")
      return json({ status: "success", server: SERVER_INFO, usage: { uptime_seconds: Math.round((Date.now() - meter.started) / 1000), total_calls: meter.total, rejected: meter.rejected, by_tool: meter.byTool } });

    // ---- MCP over Streamable HTTP ----
    if (path === "/mcp" || path === "/mcp/") {
      if (request.method === "GET") return new Response("Method Not Allowed (no server-initiated stream)", { status: 405, headers: CORS });
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
      let payload;
      try { payload = await request.json(); }
      catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: body must be valid JSON-RPC." } }, 400); }

      const who = await B.identify(request, env);
      const limits = B.planLimits(env);
      who.limit = who.plan === "pro" ? limits.pro : who.plan === "starter" ? limits.starter : limits.free;

      if (Array.isArray(payload)) {
        const out = [];
        for (const m of payload) { const r = await handleRpc(m, who, env); if (r) out.push(r); }
        return out.length ? sse(out) : new Response(null, { status: 202, headers: CORS });
      }
      const resp = await handleRpc(payload, who, env);
      if (resp === null) return new Response(null, { status: 202, headers: CORS });
      return sse(resp);
    }

    // Static landing page + assets.
    return env.ASSETS.fetch(request);
  },
};
