import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entryPoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const client = new Client({ name: "reliability-toolkit-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [entryPoint] });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["compose_reliability_pattern", "compute_slo_burn", "design_circuit_breaker", "design_rate_limiter"],
  );

  const result = await client.callTool({
    name: "compute_slo_burn",
    arguments: { target: 0.99, failures: 1, total: 100, window_seconds: 3600 },
  });
  assert.notEqual(result.isError, true);
  const text = result.content.find((part) => part.type === "text")?.text;
  assert.equal(typeof text, "string");
  assert.ok(Math.abs(JSON.parse(text).burn_rate - 1) < 1e-9);

  const rejected = await client.callTool({
    name: "compute_slo_burn",
    arguments: { target: 0.99, failures: 1, total: 100, window_seconds: 3600, extra: true },
  });
  assert.equal(rejected.isError, true);
  process.stdout.write("MCP stdio initialize, list_tools, call_tool, invalid-input rejection: passed\n");
} finally {
  await client.close();
}
