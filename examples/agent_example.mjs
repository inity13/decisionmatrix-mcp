// End-to-end DecisionMatrix MCP client demo (Streamable HTTP).
//
// Usage:
//   node examples/agent_example.mjs                       # hits the live hosted server
//   node examples/agent_example.mjs http://127.0.0.1:8788 # hits a local `npm run dev`
//
// It performs the MCP handshake, lists tools, then calls create_decision,
// compare_two, and sensitivity_analysis and prints the structured results.
const BASE = (process.argv[2] || "https://decisionmatrix-mcp.pages.dev").replace(/\/$/, "");
const ENDPOINT = `${BASE}/mcp`;

let idc = 0;
async function call(method, params) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++idc, method, params }),
  });
  const text = await res.text();
  // The server replies with a single SSE `data:` frame (or plain JSON).
  const line = text.includes("data: ") ? text.split("data: ")[1].trim() : text.trim();
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(`RPC error: ${msg.error.message}`);
  return msg.result;
}
async function tool(name, args) {
  const r = await call("tools/call", { name, arguments: args });
  return r.structuredContent; // the agent-friendly envelope
}

const rule = (t) => console.log(`\n\x1b[1m== ${t} ==\x1b[0m`);

async function main() {
  console.log(`DecisionMatrix MCP demo → ${ENDPOINT}`);

  rule("initialize");
  const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  console.log(init.serverInfo);

  rule("tools/list");
  const list = await call("tools/list", {});
  for (const t of list.tools) console.log(`• ${t.name}`);

  rule("create_decision — choosing a cloud provider");
  const decision = await tool("create_decision", {
    options: ["AWS", "GCP", "Azure"],
    criteria: [
      { name: "Cost", weight: 3, direction: "cost" },
      { name: "Performance", weight: 2, direction: "benefit" },
      { name: "Ecosystem", weight: 2, direction: "benefit" },
      { name: "Learning Curve", weight: 1, direction: "cost" },
    ],
    scores: {
      AWS: { Cost: 100, Performance: 9, Ecosystem: 10, "Learning Curve": 8 },
      GCP: { Cost: 85, Performance: 8, Ecosystem: 7, "Learning Curve": 5 },
      Azure: { Cost: 95, Performance: 8, Ecosystem: 8, "Learning Curve": 7 },
    },
    method: "weighted_sum",
  });
  console.log(`Winner: ${decision.winner.option} (${decision.winner.score})`);
  console.table(decision.ranking.map((r) => ({ rank: r.rank, option: r.option, score: r.score })));
  console.log(decision.explanation);

  rule("compare_two — AWS vs GCP head-to-head");
  const vs = await tool("compare_two", {
    option_a: "AWS",
    option_b: "GCP",
    criteria: [
      { name: "Cost", weight: 3, direction: "cost" },
      { name: "Performance", weight: 2, direction: "benefit" },
    ],
    scores: { AWS: { Cost: 100, Performance: 9 }, GCP: { Cost: 85, Performance: 8 } },
  });
  console.log(vs.explanation);

  rule("sensitivity_analysis — is the winner robust?");
  const sa = await tool("sensitivity_analysis", {
    options: ["AWS", "GCP", "Azure"],
    criteria: [
      { name: "Cost", weight: 3, direction: "cost" },
      { name: "Performance", weight: 2, direction: "benefit" },
      { name: "Ecosystem", weight: 2, direction: "benefit" },
    ],
    scores: {
      AWS: { Cost: 100, Performance: 9, Ecosystem: 10 },
      GCP: { Cost: 85, Performance: 8, Ecosystem: 7 },
      Azure: { Cost: 95, Performance: 8, Ecosystem: 8 },
    },
    variation: 0.25,
    steps: 8,
  });
  console.log(`Robustness: ${sa.robustness_pct} — ${sa.explanation}`);
}

main().catch((e) => {
  console.error("Demo failed:", e.message);
  process.exit(1);
});
