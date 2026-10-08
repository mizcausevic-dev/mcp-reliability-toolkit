/**
 * SRE math primitives — pure functions, no I/O, fully unit-tested.
 *
 * These are the same shapes used by `slo-budget-tracker` (Python) and
 * `reliability-toolkit-rs` (Rust). The MCP tools in `src/tools/*.ts` are thin
 * wrappers that validate inputs with Zod and call into here.
 *
 * All references back to the Google SRE workbook so reviewers can sanity-check:
 *   https://sre.google/workbook/alerting-on-slos/
 */

export interface SLOBurnInput {
  /** Target success ratio in (0, 1). E.g. 0.999 for three nines. */
  target: number;
  /** Failures observed in the window. */
  failures: number;
  /** Total observations in the window. */
  total: number;
  /** Window length in seconds (used only for time-to-exhaustion math). */
  window_seconds: number;
}

export interface SLOBurnOutput {
  /** Actual success ratio over the window. */
  success_ratio: number;
  /** 1 - target. */
  error_budget_ratio: number;
  /** Allowed failures = error_budget_ratio * total. */
  error_budget_failures: number;
  /** Fraction of the error budget remaining (1.0 = untouched, <=0 = exhausted). */
  error_budget_remaining: number;
  /** burn_rate = (1 - success_ratio) / (1 - target). 1.0 == "burning at allowed pace". */
  burn_rate: number;
  /** Estimated seconds until the budget is fully spent at the current burn rate. */
  seconds_to_exhaustion: number | null;
  /** Whether actual ratio is below the target. */
  is_breached: boolean;
  /** Convenience: alert level when paired with SRE workbook windows. */
  alert_level: "ok" | "watch" | "fast_burn" | "page";
}

/**
 * Compute every interesting SLO statistic from raw observation counts.
 * Mirrors `slo-budget-tracker.SLOTracker.snapshot()`.
 */
export function computeBurn(input: SLOBurnInput): SLOBurnOutput {
  const { target, failures, total, window_seconds } = input;

  if (!Number.isFinite(target) || target <= 0 || target >= 1) {
    throw new RangeError(`target must be in (0, 1); got ${target}`);
  }
  if (!Number.isSafeInteger(failures) || failures < 0) {
    throw new RangeError(`failures must be a non-negative safe integer; got ${failures}`);
  }
  if (!Number.isSafeInteger(total) || total < 0 || total < failures) {
    throw new RangeError(`total must be a non-negative safe integer and >= failures; got total=${total}, failures=${failures}`);
  }
  if (!Number.isSafeInteger(window_seconds) || window_seconds <= 0) {
    throw new RangeError(`window_seconds must be a positive safe integer; got ${window_seconds}`);
  }

  const success_ratio = total === 0 ? 1.0 : (total - failures) / total;
  const error_budget_ratio = 1 - target;
  const error_budget_failures = error_budget_ratio * total;
  const error_budget_remaining =
    error_budget_failures === 0 ? 1.0 : (error_budget_failures - failures) / error_budget_failures;
  const burn_rate = (1 - success_ratio) / error_budget_ratio;
  const seconds_to_exhaustion = computeSecondsToExhaustion(error_budget_remaining, burn_rate, window_seconds);
  const is_breached = success_ratio < target;
  const alert_level = alertLevelFor(burn_rate);

  return {
    success_ratio,
    error_budget_ratio,
    error_budget_failures,
    error_budget_remaining,
    burn_rate,
    seconds_to_exhaustion,
    is_breached,
    alert_level,
  };
}

function computeSecondsToExhaustion(
  remaining: number,
  burnRate: number,
  windowSeconds: number,
): number | null {
  if (remaining <= 0) {
    return 0;
  }
  if (burnRate <= 0) {
    return null;
  }
  // At burn_rate=1, the budget lasts exactly the window. At burn_rate=N, it
  // lasts window/N. Remaining-fraction scales that linearly.
  return (remaining * windowSeconds) / burnRate;
}

function alertLevelFor(burnRate: number): "ok" | "watch" | "fast_burn" | "page" {
  // Following the SRE workbook's multi-burn-rate thresholds (1h/2%, 6h/5%, ...).
  if (burnRate >= 14.4) return "page";
  if (burnRate >= 6) return "fast_burn";
  if (burnRate >= 1) return "watch";
  return "ok";
}

// ---------------------------------------------------------------------------
// Rate limiter sizing
// ---------------------------------------------------------------------------

export interface RateLimiterDesignInput {
  /** Expected steady-state requests per second. */
  rps: number;
  /** Acceptable burst factor — bucket capacity = rps * burst_factor. Default 2. */
  burst_factor?: number;
  /** How many concurrent callers are typical (used to size bulkhead suggestion). */
  expected_concurrency?: number;
}

export interface RateLimiterDesignOutput {
  rps: number;
  burst: number;
  refill_interval_ms: number;
  bulkhead_capacity: number;
  /** Setup examples; callers must wire them into their request paths. */
  config: {
    python: string;
    rust: string;
    json: Record<string, unknown>;
  };
}

const MIN_RPS = 1 / (365 * 24 * 3600);

export function designRateLimiter(input: RateLimiterDesignInput): RateLimiterDesignOutput {
  const { rps, burst_factor = 2, expected_concurrency = 0 } = input;

  if (!Number.isFinite(rps) || rps < MIN_RPS) {
    throw new RangeError(`rps must be at least one request per year; got ${rps}`);
  }
  if (!Number.isFinite(burst_factor) || burst_factor < 1) {
    throw new RangeError(`burst_factor must be >= 1; got ${burst_factor}`);
  }
  if (!Number.isFinite(expected_concurrency) || expected_concurrency < 0) {
    throw new RangeError(`expected_concurrency must be non-negative; got ${expected_concurrency}`);
  }

  const burst = Math.max(1, Math.ceil(rps * burst_factor));
  if (!Number.isSafeInteger(burst) || burst > 0xffff_ffff) {
    throw new RangeError("rps * burst_factor exceeds the Rust limiter's u32 burst capacity");
  }
  const refill_interval_ms = 1000 / rps;
  if (!Number.isFinite(refill_interval_ms)) {
    throw new RangeError("rps is too small to represent a finite refill interval");
  }
  // A pragmatic bulkhead suggestion: enough to soak the burst at 2x concurrency.
  const bulkhead_capacity = Math.max(burst, Math.ceil(expected_concurrency * 2) || burst);
  if (!Number.isSafeInteger(bulkhead_capacity)) {
    throw new RangeError("bulkhead_capacity must be a safe integer");
  }

  return {
    rps,
    burst,
    refill_interval_ms,
    bulkhead_capacity,
    config: {
      python: pythonRateLimiterSnippet(rps, burst, bulkhead_capacity),
      rust: rustRateLimiterSnippet(rps, burst, bulkhead_capacity),
      json: {
        rate_limiter: { rps, burst },
        bulkhead: { capacity: bulkhead_capacity },
      },
    },
  };
}

function pythonRateLimiterSnippet(rps: number, burst: number, bulkhead: number): string {
  return [
    "# Install rate-limit-shield from a reviewed source revision (not currently on PyPI)",
    "from threading import BoundedSemaphore",
    "from rate_limit_shield import TokenBucket",
    "",
    `limiter = TokenBucket(capacity=${burst}, refill_rate=${rps})`,
    `bulkhead = BoundedSemaphore(value=${bulkhead})`,
  ].join("\n");
}

function rustRateLimiterSnippet(rps: number, burst: number, bulkhead: number): string {
  return [
    "use reliability_toolkit::{RateLimiter, Bulkhead};",
    "",
    `let limiter = RateLimiter::new(${rustFloat(rps)}, ${burst});`,
    `let pool    = Bulkhead::new(${bulkhead});`,
  ].join("\n");
}

function rustFloat(value: number): string {
  const literal = String(value);
  return /[.eE]/.test(literal) ? literal : `${literal}.0`;
}

// ---------------------------------------------------------------------------
// Circuit breaker sizing
// ---------------------------------------------------------------------------

export interface BreakerDesignInput {
  /** Allowable consecutive failures before the breaker trips. Default 5. */
  failure_threshold?: number;
  /** Seconds to stay open before allowing a trial call. Default 30. */
  cool_down_seconds?: number;
  /** Calls admitted in half-open. Default 1. */
  half_open_max_calls?: number;
  /** Optional SLO target for context; an SLO target alone cannot determine a
   *  consecutive-failure threshold without request volume and failure shape. */
  protected_slo_target?: number;
}

export interface BreakerDesignOutput {
  failure_threshold: number;
  cool_down_seconds: number;
  half_open_max_calls: number;
  notes: string[];
  config: {
    python: string;
    rust: string;
    json: Record<string, unknown>;
  };
}

export function designCircuitBreaker(input: BreakerDesignInput): BreakerDesignOutput {
  const {
    failure_threshold = 5,
    cool_down_seconds = 30,
    half_open_max_calls = 1,
    protected_slo_target,
  } = input;

  if (!Number.isSafeInteger(failure_threshold) || failure_threshold < 1 || failure_threshold > 0xffff_ffff) {
    throw new RangeError(`failure_threshold must be a positive integer; got ${failure_threshold}`);
  }
  if (!Number.isFinite(cool_down_seconds) || cool_down_seconds <= 0 || cool_down_seconds > 365 * 24 * 3600) {
    throw new RangeError(`cool_down_seconds must be in (0, 31536000]; got ${cool_down_seconds}`);
  }
  if (!Number.isSafeInteger(half_open_max_calls) || half_open_max_calls < 1 || half_open_max_calls > 0xffff_ffff) {
    throw new RangeError(`half_open_max_calls must be a positive integer; got ${half_open_max_calls}`);
  }
  if (protected_slo_target !== undefined &&
      (!Number.isFinite(protected_slo_target) || protected_slo_target <= 0 || protected_slo_target >= 1)) {
    throw new RangeError(`protected_slo_target must be in (0, 1); got ${protected_slo_target}`);
  }

  const notes: string[] = [];
  if (protected_slo_target !== undefined) {
    notes.push(
      `Protected SLO ${protected_slo_target} does not determine a consecutive-failure threshold. ` +
        "Validate this setting against request volume and the observed failure pattern.",
    );
  }
  if (cool_down_seconds < 10) {
    notes.push("cool_down_seconds < 10s tends to flap. 10-60s is the typical sweet spot.");
  }

  return {
    failure_threshold,
    cool_down_seconds,
    half_open_max_calls,
    notes,
    config: {
      python: pythonBreakerSnippet(failure_threshold, cool_down_seconds, half_open_max_calls),
      rust: rustBreakerSnippet(failure_threshold, cool_down_seconds, half_open_max_calls),
      json: {
        circuit_breaker: {
          failure_threshold,
          cool_down_seconds,
          half_open_max_calls,
        },
      },
    },
  };
}

function pythonBreakerSnippet(threshold: number, cool: number, halfOpen: number): string {
  return [
    "# Install rate-limit-shield from a reviewed source revision (not currently on PyPI)",
    "from rate_limit_shield import CircuitBreaker",
    "",
    `breaker = CircuitBreaker(`,
    `    failure_threshold=${threshold},`,
    `    recovery_timeout=${cool},`,
    `    half_open_max_calls=${halfOpen},`,
    `)`,
  ].join("\n");
}

function rustBreakerSnippet(threshold: number, cool: number, halfOpen: number): string {
  return [
    "use std::time::Duration;",
    "use reliability_toolkit::CircuitBreaker;",
    "",
    `let breaker = CircuitBreaker::builder()`,
    `    .failure_threshold(${threshold})`,
    `    .cool_down(Duration::from_secs_f64(${rustFloat(cool)}))`,
    `    .half_open_max_calls(${halfOpen})`,
    `    .build();`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Layered "compose pattern" recommendation
// ---------------------------------------------------------------------------

export interface ComposePatternInput {
  service_name: string;
  rps: number;
  protected_slo_target: number;
  expected_concurrency?: number;
}

export interface ComposePatternOutput {
  service_name: string;
  layers: string[];
  rate_limiter: RateLimiterDesignOutput;
  circuit_breaker: BreakerDesignOutput;
  slo: { target: number; window_seconds: number };
  /** Setup examples for selected layers; retry and telemetry wiring remain external. */
  config: {
    python: string;
    rust: string;
  };
}

export function composePattern(input: ComposePatternInput): ComposePatternOutput {
  const { service_name, rps, protected_slo_target, expected_concurrency = 0 } = input;
  if (!service_name || !service_name.trim() || service_name.length > 128 || /[\x00-\x1f\x7f\u2028\u2029]/.test(service_name)) {
    throw new RangeError("service_name must be 1-128 printable characters");
  }

  const rl = designRateLimiter({ rps, expected_concurrency });
  const cb = designCircuitBreaker({ protected_slo_target });

  return {
    service_name,
    layers: [
      "1. RateLimiter — protect the downstream rps budget",
      "2. Bulkhead — cap in-flight concurrency",
      "3. CircuitBreaker — short-circuit when the downstream is unhealthy",
      "4. Retry with full jitter — recover from transient failures only",
      "5. SLO tracker + multi-window burn-rate alerts (1h + 6h) for paging",
    ],
    rate_limiter: rl,
    circuit_breaker: cb,
    slo: { target: protected_slo_target, window_seconds: 30 * 24 * 3600 },
    config: {
      python: [
        "# Composed reliability stack",
        rl.config.python,
        "",
        cb.config.python,
        "",
        "# pip install slo-budget-tracker",
        "from slo_budget_tracker import SLODefinition, SLOTracker",
        `slo = SLOTracker(SLODefinition(name=${JSON.stringify(service_name)}, target=${protected_slo_target}))`,
      ].join("\n"),
      rust: [
        "// Composed reliability stack",
        rl.config.rust,
        "",
        cb.config.rust,
      ].join("\n"),
    },
  };
}
