import { describe, expect, it } from "vitest";

import {
  composePattern,
  computeBurn,
  designCircuitBreaker,
  designRateLimiter,
} from "../src/sre_math.js";

describe("computeBurn", () => {
  it("clean window with no failures has full budget and burn_rate 0", () => {
    const out = computeBurn({ target: 0.99, failures: 0, total: 1_000, window_seconds: 3600 });
    expect(out.success_ratio).toBe(1);
    expect(out.error_budget_remaining).toBe(1);
    expect(out.burn_rate).toBe(0);
    expect(out.is_breached).toBe(false);
    expect(out.alert_level).toBe("ok");
  });

  it("at exactly the SLO target, burn_rate == 1 and budget == 0", () => {
    // target 0.99 with 100 events + 1 failure -> success_ratio 0.99 exactly.
    const out = computeBurn({ target: 0.99, failures: 1, total: 100, window_seconds: 3600 });
    expect(out.success_ratio).toBeCloseTo(0.99);
    expect(out.burn_rate).toBeCloseTo(1.0);
    expect(out.error_budget_remaining).toBeCloseTo(0, 8);
    expect(out.is_breached).toBe(false);
    expect(out.alert_level).toBe("watch");
  });

  it("breach is detected and budget goes negative (fast-burn tier)", () => {
    // 7 failures over 100 obs at target 0.99 -> success_ratio 0.93,
    // burn_rate 7.0 (>= 6 = fast_burn).
    const out = computeBurn({ target: 0.99, failures: 7, total: 100, window_seconds: 3600 });
    expect(out.success_ratio).toBeCloseTo(0.93);
    expect(out.is_breached).toBe(true);
    expect(out.error_budget_remaining).toBeLessThan(0);
    expect(out.burn_rate).toBeCloseTo(7.0);
    expect(out.alert_level).toBe("fast_burn");
  });

  it("burn rate in 1..6 maps to watch", () => {
    const out = computeBurn({ target: 0.99, failures: 5, total: 100, window_seconds: 3600 });
    expect(out.burn_rate).toBeCloseTo(5.0);
    expect(out.alert_level).toBe("watch");
  });

  it("page-level burn at the SRE workbook threshold of 14.4", () => {
    // burn_rate >= 14.4 should map to page.
    const out = computeBurn({ target: 0.99, failures: 15, total: 100, window_seconds: 3600 });
    expect(out.burn_rate).toBeGreaterThanOrEqual(14.4);
    expect(out.alert_level).toBe("page");
  });

  it("seconds_to_exhaustion is null when burn_rate is 0", () => {
    const out = computeBurn({ target: 0.99, failures: 0, total: 1_000, window_seconds: 3600 });
    expect(out.seconds_to_exhaustion).toBeNull();
  });

  it("rejects target outside (0, 1)", () => {
    expect(() => computeBurn({ target: 1, failures: 0, total: 10, window_seconds: 10 })).toThrow();
    expect(() => computeBurn({ target: 0, failures: 0, total: 10, window_seconds: 10 })).toThrow();
  });

  it("rejects negative or impossible counts", () => {
    expect(() => computeBurn({ target: 0.99, failures: -1, total: 100, window_seconds: 60 })).toThrow();
    expect(() => computeBurn({ target: 0.99, failures: 50, total: 10, window_seconds: 60 })).toThrow();
  });
});

describe("designRateLimiter", () => {
  it("burst defaults to 2x rps", () => {
    const out = designRateLimiter({ rps: 100 });
    expect(out.rps).toBe(100);
    expect(out.burst).toBe(200);
    expect(out.refill_interval_ms).toBeCloseTo(10);
  });

  it("burst_factor controls burst", () => {
    const out = designRateLimiter({ rps: 100, burst_factor: 1.5 });
    expect(out.burst).toBe(150);
  });

  it("bulkhead_capacity follows concurrency when supplied", () => {
    const out = designRateLimiter({ rps: 100, expected_concurrency: 200 });
    expect(out.bulkhead_capacity).toBe(400); // 2x concurrency dominates the default
  });

  it("emits Python and Rust snippets that reference the right primitives", () => {
    const out = designRateLimiter({ rps: 50 });
    expect(out.config.python).toContain("RateLimiter(rps=50");
    expect(out.config.rust).toContain("RateLimiter::new(50");
  });

  it("rejects non-positive rps", () => {
    expect(() => designRateLimiter({ rps: 0 })).toThrow();
    expect(() => designRateLimiter({ rps: -1 })).toThrow();
  });
});

describe("designCircuitBreaker", () => {
  it("uses sensible defaults", () => {
    const out = designCircuitBreaker({});
    expect(out.failure_threshold).toBe(5);
    expect(out.cool_down_seconds).toBe(30);
    expect(out.half_open_max_calls).toBe(1);
  });

  it("flags a generous threshold against a tight SLO budget", () => {
    const out = designCircuitBreaker({ failure_threshold: 50, protected_slo_target: 0.999 });
    expect(out.notes.some((n) => /failure_threshold/.test(n))).toBe(true);
  });

  it("flags short cool-downs", () => {
    const out = designCircuitBreaker({ cool_down_seconds: 5 });
    expect(out.notes.some((n) => /flap/.test(n))).toBe(true);
  });

  it("snippets reference the public API", () => {
    const out = designCircuitBreaker({ failure_threshold: 3, cool_down_seconds: 20 });
    expect(out.config.python).toContain("CircuitBreaker(");
    expect(out.config.python).toContain("failure_threshold=3");
    expect(out.config.rust).toContain(".failure_threshold(3)");
    expect(out.config.rust).toContain("Duration::from_secs(20)");
  });

  it("rejects invalid SLO target", () => {
    expect(() => designCircuitBreaker({ protected_slo_target: 1 })).toThrow();
    expect(() => designCircuitBreaker({ protected_slo_target: 0 })).toThrow();
  });
});

describe("composePattern", () => {
  it("returns the canonical layered stack", () => {
    const out = composePattern({
      service_name: "checkout",
      rps: 200,
      protected_slo_target: 0.999,
    });
    expect(out.service_name).toBe("checkout");
    expect(out.layers).toHaveLength(5);
    expect(out.rate_limiter.rps).toBe(200);
    expect(out.slo.target).toBe(0.999);
    expect(out.config.python).toContain("checkout");
    expect(out.config.rust).toContain("checkout");
  });

  it("rejects an empty service name", () => {
    expect(() =>
      composePattern({ service_name: "", rps: 100, protected_slo_target: 0.99 }),
    ).toThrow();
  });
});
