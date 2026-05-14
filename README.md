# mcp-reliability-toolkit

[![CI](https://github.com/mizcausevic-dev/mcp-reliability-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/mizcausevic-dev/mcp-reliability-toolkit/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**MCP server that exposes the Platform Reliability Stack's math as Claude-callable tools.** Compute SLO burn rate, size a token-bucket rate limiter, pick circuit-breaker thresholds, or generate a whole layered reliability stack — and get drop-in Python + Rust configs back.

Pairs with:

- **[slo-budget-tracker](https://github.com/mizcausevic-dev/slo-budget-tracker)** — Python SLO + error-budget library.
- **[reliability-toolkit-rs](https://github.com/mizcausevic-dev/reliability-toolkit-rs)** — Rust async reliability primitives.
- **[rate-limit-shield](https://github.com/mizcausevic-dev/rate-limit-shield)** — Python rate-limit + circuit-breaker + retry.

---

## Why

The Platform Reliability Stack already gives you the math (`slo-budget-tracker`) and the primitives (`reliability-toolkit-rs`). What it didn't give you was the moment in a design conversation where you say "Claude, given 500 rps and a 99.9 SLO, what should my breaker + bulkhead look like?" — and have Claude actually compute it instead of vibing.

This server fills that gap. Every tool is a thin, validated wrapper around pure math from `src/sre_math.ts`. The numbers Claude shows you are the same numbers `slo-budget-tracker` would compute server-side. There's no LLM-in-the-loop math.

---

## Tools

| Tool | What it does |
| --- | --- |
| `compute_slo_burn` | Burn rate, error budget remaining, time-to-exhaustion, SRE-workbook alert level — from raw `(target, failures, total, window_seconds)`. Mirrors `slo-budget-tracker.SLOTracker.snapshot()`. |
| `design_rate_limiter` | Token-bucket sizing from `rps` + `burst_factor`, plus Python (`rate-limit-shield`) and Rust (`reliability-toolkit`) snippets and a JSON config. |
| `design_circuit_breaker` | Threshold + cool-down + half-open sizing with sanity-check notes. When `protected_slo_target` is supplied it flags settings that look inconsistent with the SLO's error budget. |
| `compose_reliability_pattern` | Given service name + rps + protected SLO target, returns the canonical layered stack — rate-limit → bulkhead → breaker → retry → SLO tracker — plus a paste-ready Python and Rust config. |

Each tool advertises a JSON Schema. Bad input is rejected with a typed error — no silent coercion.

---

## Install

The server speaks stdio MCP, the same shape as every Claude Desktop tool.

### Quick start

```bash
npm install -g mcp-reliability-toolkit
```

```jsonc
// ~/.config/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "reliability-toolkit": {
      "command": "mcp-reliability-toolkit"
    }
  }
}
```

Restart Claude Desktop. The four tools above will appear under the tools panel.

### Run locally from source

```bash
git clone https://github.com/mizcausevic-dev/mcp-reliability-toolkit.git
cd mcp-reliability-toolkit
npm install
npm run build
node dist/index.js   # speaks MCP stdio
```

Then wire `dist/index.js` into the same `claude_desktop_config.json` block, using an absolute path.

---

## Example interaction

> *"My checkout service does 200 rps and we want three nines. Design the stack."*

Claude calls `compose_reliability_pattern({ service_name: "checkout", rps: 200, protected_slo_target: 0.999 })` and gets back:

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
      "python": "from rate_limit_shield import RateLimiter, Bulkhead\nlimiter = RateLimiter(rps=200, burst=400)\nbulkhead = Bulkhead(capacity=400)",
      "rust":   "use reliability_toolkit::{RateLimiter, Bulkhead};\nlet limiter = RateLimiter::new(200.0, 400);\nlet pool    = Bulkhead::new(400);"
    }
  },
  "circuit_breaker": { "failure_threshold": 5, "cool_down_seconds": 30, ... },
  "slo": { "target": 0.999, "window_seconds": 2592000 }
}
```

…with a paste-ready Python and Rust config block at the end. Claude reads the tool output and explains the recommendation; the math came from a deterministic function, not the model.

---

## Tests

```bash
npm install
npm run typecheck
npm run build
npm test
```

CI matrix runs Node 20 and 22.

---

## Layout

```
src/
  index.ts        # MCP stdio server entry point
  tools.ts        # tool registry: zod schemas, JSON-Schema export, handlers
  sre_math.ts     # pure functions; identical math to slo-budget-tracker
tests/
  sre_math.test.ts
  tools.test.ts
```

Adding a new tool is one push to the `tools` array in `tools.ts` — zod schema in, handler out, done.

---

## License

MIT. See [LICENSE](LICENSE).
