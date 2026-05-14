import { beforeAll, describe, expect, it } from "vitest";

import { registerTools, tools } from "../src/tools.js";

beforeAll(() => {
  registerTools();
});

describe("MCP tool registry", () => {
  it("registers the four expected tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "compose_reliability_pattern",
      "compute_slo_burn",
      "design_circuit_breaker",
      "design_rate_limiter",
    ]);
  });

  it("each tool advertises an object input schema with no extra properties", () => {
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("compute_slo_burn handler returns the expected fields", () => {
    const burn = tools.find((t) => t.name === "compute_slo_burn")!;
    const result = burn.handler({
      target: 0.99,
      failures: 1,
      total: 100,
      window_seconds: 3600,
    }) as Record<string, unknown>;
    expect(typeof result.burn_rate).toBe("number");
    expect(typeof result.alert_level).toBe("string");
    expect(result.is_breached).toBe(false);
  });

  it("design_rate_limiter handler emits both language snippets", () => {
    const tool = tools.find((t) => t.name === "design_rate_limiter")!;
    const result = tool.handler({ rps: 50 }) as Record<string, { python: string; rust: string }>;
    expect(result.config.python).toContain("RateLimiter");
    expect(result.config.rust).toContain("RateLimiter::new(50");
  });

  it("design_circuit_breaker validates inputs", () => {
    const tool = tools.find((t) => t.name === "design_circuit_breaker")!;
    // failure_threshold must be a positive integer.
    expect(() => tool.handler({ failure_threshold: 0 })).toThrow();
    expect(() => tool.handler({ failure_threshold: 1.5 })).toThrow();
  });

  it("compose_reliability_pattern returns the layered stack + config", () => {
    const tool = tools.find((t) => t.name === "compose_reliability_pattern")!;
    const result = tool.handler({
      service_name: "checkout",
      rps: 200,
      protected_slo_target: 0.999,
    }) as Record<string, unknown>;
    expect(Array.isArray(result.layers)).toBe(true);
    expect((result.layers as string[]).length).toBe(5);
  });

  it("rejects an unknown argument shape", () => {
    const burn = tools.find((t) => t.name === "compute_slo_burn")!;
    expect(() => burn.handler({ target: "high", failures: 1, total: 100, window_seconds: 1 })).toThrow();
  });
});
