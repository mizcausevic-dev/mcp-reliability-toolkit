# mcp-reliability-toolkit

[![CI](https://github.com/mizcausevic-dev/mcp-reliability-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/mizcausevic-dev/mcp-reliability-toolkit/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Local stdio MCP server for reliability planning.** Compute SLO burn rate, size a token bucket, and generate Python/Rust setup examples for a proposed reliability pattern. The examples require integration review; the server does not observe a live service or enforce a policy.

Pairs with:

- **[slo-budget-tracker](https://github.com/mizcausevic-dev/slo-budget-tracker)** — Python SLO + error-budget library.
- **[reliability-toolkit-rs](https://github.com/mizcausevic-dev/reliability-toolkit-rs)** — Rust async reliability primitives.
- **[rate-limit-shield](https://github.com/mizcausevic-dev/rate-limit-shield)** — Python rate-limit + circuit-breaker + retry.

---

## Why

The Platform Reliability Stack already gives you the math (`slo-budget-tracker`) and the primitives (`reliability-toolkit-rs`). What it didn't give you was the moment in a design conversation where you say "Claude, given 500 rps and a 99.9 SLO, what should my breaker + bulkhead look like?" — and have Claude actually compute it instead of vibing.

This server provides deterministic calculations from `src/sre_math.ts`. Its success ratio, error budget remaining, and burn rate match the corresponding `slo-budget-tracker` snapshot formulas for the same counts. Its single-window alert tier and time-to-exhaustion are estimates; `slo-budget-tracker` uses separately sampled windows for alerts. No LLM computes the numbers.

---

## Tools

| Tool | What it does |
| --- | --- |
| `compute_slo_burn` | Burn rate and error budget from raw `(target, failures, total, window_seconds)`, plus a single-window alert tier and exhaustion estimate. This does not make a paging decision. |
| `design_rate_limiter` | Token-bucket sizing from `rps` + `burst_factor`, plus Python (`rate-limit-shield`) and Rust (`reliability-toolkit`) setup examples and a JSON config. |
| `design_circuit_breaker` | Threshold + cool-down + half-open setup examples with basic validation notes. An SLO target alone cannot determine a safe consecutive-failure threshold. |
| `compose_reliability_pattern` | Given service name + rps + protected SLO target, returns a proposed layered design and setup examples. Retry, monitoring, and call-path wiring are not implemented by the generated snippets. |

Each tool advertises a JSON Schema. Bad input, including unknown fields, is rejected without coercion.

The server uses stdio only. Its handlers read caller-supplied values and return calculations; they do not read service telemetry, call providers, persist requests, or open an HTTP listener. Your MCP client controls any onward use of the returned text.

---

## Install

The server speaks stdio MCP. **This package is not currently published on npm.** Build from the reviewed source revision and point your MCP client at its absolute entry-point path.

### Build from source

```bash
git clone https://github.com/mizcausevic-dev/mcp-reliability-toolkit.git
cd mcp-reliability-toolkit
npm ci
npm run build
```

```jsonc
// Claude Desktop MCP configuration (choose the path for your OS)
{
  "mcpServers": {
    "reliability-toolkit": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-reliability-toolkit/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. Windows users can set `args` to a full path such as `C:\\Users\\you\\mcp-reliability-toolkit\\dist\\index.js`.

---

## Example interaction

> *"My checkout service does 200 rps and we want three nines. Design the stack."*

Claude calls `compose_reliability_pattern({ service_name: "checkout", rps: 200, protected_slo_target: 0.999 })` and gets back a proposed design. Relevant fields include:

```json
{
  "service_name": "checkout",
  "layers": [
    "1. RateLimiter — protect the downstream rps budget",
    "2. Bulkhead — cap in-flight concurrency",
    "3. CircuitBreaker — short-circuit when the downstream is unhealthy",
    "4. Retry with full jitter — recover from transient failures only",
    "5. SLO tracker + multi-window burn-rate alerts (1h + 6h) for paging"
  ],
  "rate_limiter": {
    "rps": 200, "burst": 400, "refill_interval_ms": 5,
    "bulkhead_capacity": 400,
    "config": {
      "python": "from threading import BoundedSemaphore\nfrom rate_limit_shield import TokenBucket\nlimiter = TokenBucket(capacity=400, refill_rate=200)\nbulkhead = BoundedSemaphore(value=400)",
      "rust":   "use reliability_toolkit::{RateLimiter, Bulkhead};\nlet limiter = RateLimiter::new(200.0, 400);\nlet pool    = Bulkhead::new(400);"
    }
  },
  "circuit_breaker": { "failure_threshold": 5, "cool_down_seconds": 30 },
  "slo": { "target": 0.999, "window_seconds": 2592000 }
}
```

The Python example uses `rate-limit-shield.TokenBucket`, its `CircuitBreaker`, and a standard-library semaphore. The Rust example uses `reliability-toolkit` primitives. These are setup snippets, not a complete runnable service. Review burst/concurrency assumptions, configure retries and telemetry, and test against real traffic before adopting them.

`rate-limit-shield` was not available from PyPI when checked for this review; install a reviewed revision from its [source repository](https://github.com/mizcausevic-dev/rate-limit-shield) before running the Python example. `slo-budget-tracker` and the `reliability-toolkit` Rust crate have published packages, but this repository does not pin or bundle them.

---

## Tests

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:stdio
npm run test:recipes # requires local Python and rustc; validates syntax against stub Rust signatures
npm run lint
```

CI matrix runs Node 20 and 22.

---

## Layout

```
src/
  index.ts        # MCP stdio server entry point
  tools.ts        # tool registry: zod schemas, JSON-Schema export, handlers
  sre_math.ts     # pure functions; core ratio and burn formulas match slo-budget-tracker
tests/
  sre_math.test.ts
  tools.test.ts
```

Adding a new tool is one push to the `tools` array in `tools.ts` — zod schema in, handler out, done.

---

## License

MIT. See [LICENSE](LICENSE).
