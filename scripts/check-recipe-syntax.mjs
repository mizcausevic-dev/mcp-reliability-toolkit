import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { composePattern, designCircuitBreaker, designRateLimiter } from "../dist/sre_math.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-reliability-recipes-"));
const pythonPath = join(dir, "recipe.py");
const rustPath = join(dir, "recipe.rs");
const rustMetadataPath = join(dir, "recipe.rmeta");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${command} failed: ${result.error?.message ?? ""}\n${result.stderr}`);
}

try {
  const rate = designRateLimiter({ rps: 0.5 });
  const breaker = designCircuitBreaker({ cool_down_seconds: 0.5 });
  const composed = composePattern({
    service_name: 'checkout"; print("unexpected")',
    rps: 0.5,
    protected_slo_target: 0.999,
  });

  writeFileSync(pythonPath, [rate.config.python, breaker.config.python, composed.config.python].join("\n\n"));
  run("python", ["-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", pythonPath]);
  assert.ok(readFileSync(pythonPath, "utf8").includes('name="checkout\\\"; print(\\\"unexpected\\\")"'));

  // Stub signatures mirror the inspected public reliability-toolkit-rs API.
  // This compiles emitted Rust syntax and types, without linking the actual crate.
  const rustStub = `
mod reliability_toolkit {
  pub struct RateLimiter;
  impl RateLimiter { pub fn new(_: f64, _: u32) -> Self { Self } }
  pub struct Bulkhead;
  impl Bulkhead { pub fn new(_: usize) -> Self { Self } }
  pub struct CircuitBreaker;
  pub struct CircuitBreakerBuilder;
  impl CircuitBreaker { pub fn builder() -> CircuitBreakerBuilder { CircuitBreakerBuilder } }
  impl CircuitBreakerBuilder {
    pub fn failure_threshold(self, _: u32) -> Self { self }
    pub fn cool_down(self, _: std::time::Duration) -> Self { self }
    pub fn half_open_max_calls(self, _: u32) -> Self { self }
    pub fn build(self) -> CircuitBreaker { CircuitBreaker }
  }
}
fn main() {
${rate.config.rust}
${breaker.config.rust}
}
`;
  writeFileSync(rustPath, rustStub);
  run("rustc", ["--edition=2021", "-A", "warnings", "--emit=metadata", "-o", rustMetadataPath, rustPath]);
  process.stdout.write("Python AST and Rust compiler checks passed for fractional recipe inputs\n");
} finally {
  for (const path of [pythonPath, rustPath, rustMetadataPath]) {
    if (existsSync(path)) unlinkSync(path);
  }
  rmdirSync(dir);
}
