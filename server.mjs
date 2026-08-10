#!/usr/bin/env node
// DecisionMatrix MCP — local stdio server (self-host / Glama-runnable).
// Dependency-light: wraps the same deterministic engine as the hosted edge
// worker (worker-src/engine.mjs) and speaks MCP over newline-delimited JSON-RPC
// on stdio. No network, no state. Run: `node server.mjs`.
import readline from "node:readline";
import * as T from "./worker-src/engine.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "DecisionMatrix", version: "1.0.0" };

const str = { type: "string" };
const num = { type: "number" };
const criteriaSchema = {
  type: "array",
  description: "Weighted criteria. Each: {name, weight (relative, >=0), direction: 'benefit' (higher better, default) | 'cost' (lower better)}.",
  items: { type: "object", properties: { name: str, weight: num, direction: { type: "string", enum: ["benefit", "cost"], default: "benefit" } }, required: ["name", "weight"] },
};
const scoresSchema = { type: "object", description: "Score matrix. {\"Option A\": {\"Criterion 1\": 8, ...}, ...} or array form or inline on options." };
const optionsSchema = { type: "array", description: "Named alternatives. Strings or {name, scores} objects.", items: { type: ["string", "object"] } };
const methodSchema = { type: "string", enum: ["weighted_sum", "weighted_product", "topsis"], default: "weighted_sum" };

const TOOLS = {
  create_decision: {
    description: "Rank named options against weighted criteria and return the winner, full ranking, per-criterion breakdowns, methodology, weights used, and a plain-language explanation. Main tool. method defaults to weighted_sum (also weighted_product, topsis). 100% deterministic.",
    inputSchema: { type: "object", properties: { options: optionsSchema, criteria: criteriaSchema, scores: scoresSchema, method: methodSchema }, required: ["options", "criteria", "scores"] },
    handler: (a) => T.create_decision(a),
  },
  score_options: {
    description: "Score options against criteria when the score matrix is supplied separately. Returns the full normalized scored matrix + ranking, without the narrative winner explanation.",
    inputSchema: { type: "object", properties: { options: optionsSchema, criteria: criteriaSchema, scores: scoresSchema, method: methodSchema }, required: ["options", "criteria", "scores"] },
    handler: (a) => T.score_options(a),
  },
  sensitivity_analysis: {
    description: "Test how robust the winner is to criteria-weight changes. Sweeps each weight +/- 'variation' (default 0.2) over 'steps' (default 10), recomputes the ranking, and reports a robustness score, the criteria most likely to flip the result, and flip points.",
    inputSchema: { type: "object", properties: { options: optionsSchema, criteria: criteriaSchema, scores: scoresSchema, method: methodSchema, variation: { type: "number", default: 0.2 }, steps: { type: "integer", default: 10 } }, required: ["options", "criteria", "scores"] },
    handler: (a) => T.sensitivity_analysis(a),
  },
  compare_two: {
    description: "Head-to-head comparison of exactly two options. Returns the winner, score margin, how many criteria each option wins, and a per-criterion breakdown. Pass option_a/option_b (names) or a 2-element options array, plus criteria and scores.",
    inputSchema: { type: "object", properties: { option_a: str, option_b: str, options: optionsSchema, criteria: criteriaSchema, scores: scoresSchema, method: methodSchema }, required: ["criteria", "scores"] },
    handler: (a) => T.compare_two(a),
  },
  list_methods: { description: "List scoring methods (weighted_sum, weighted_product, topsis) with normalization details, score ranges, and when to use each.", inputSchema: { type: "object", properties: {} }, handler: () => T.list_methods() },
  health_check: { description: "Server health, version, and capabilities.", inputSchema: { type: "object", properties: {} }, handler: () => T.health_check() },
};

function reply(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") return reply(id, { protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  if (method === "ping") return reply(id, {});
  if (method === "notifications/initialized" || (method && method.startsWith("notifications/"))) return null;
  if (method === "tools/list") return reply(id, { tools: Object.entries(TOOLS).map(([name, s]) => ({ name, description: s.description, inputSchema: s.inputSchema })) });
  if (method === "tools/call") {
    const name = params?.name; const args = params?.arguments || {};
    const spec = TOOLS[name];
    if (!spec) return rpcError(id, -32602, `Unknown tool '${name}'.`);
    let result;
    try { result = await spec.handler(args); }
    catch (e) { result = T.errEnvelope(`Unexpected error: ${e.message}`, "internal_error"); }
    return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: result?.status === "error" });
  }
  if (id === undefined || id === null) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const res = await handle(msg);
  if (res) process.stdout.write(JSON.stringify(res) + "\n");
});
process.stderr.write("DecisionMatrix MCP stdio server ready\n");
