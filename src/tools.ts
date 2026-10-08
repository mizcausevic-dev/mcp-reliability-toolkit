/**
 * MCP tool definitions.
 *
 * Each tool: name, human-facing description, JSON-Schema input shape, and a
 * pure handler. Handlers throw on bad input; the entry point catches and turns
 * thrown errors into MCP `isError` responses. Adding a new tool means pushing
 * an entry into `tools` — no other wiring required.
 */

import { z } from "zod";

import {
  composePattern,
  computeBurn,
  designCircuitBreaker,
  designRateLimiter,
} from "./sre_math.js";

export interface ToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => unknown;
}

/** Single source of truth for the tools the server exposes. */
export const tools: ToolHandler[] = [];

const SLOBurnSchema = z.object({
  target: z.number().gt(0).lt(1).describe("SLO target ratio in (0, 1). E.g. 0.999 for three nines."),
  failures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe("Failures in the window."),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe("Total observations in the window."),
  window_seconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe("Window length in seconds."),
}).strict();

const RateLimiterSchema = z.object({
  rps: z.number().finite().min(1 / (365 * 24 * 3600)).describe("Steady-state requests per second; at least one request per year."),
  burst_factor: z
    .number()
    .finite().min(1)
    .optional()
    .describe("Token bucket capacity = rps * burst_factor. Default 2."),
  expected_concurrency: z
    .number()
    .finite().nonnegative()
    .optional()
    .describe("Typical concurrent callers; used to suggest a bulkhead size."),
}).strict();

const BreakerSchema = z.object({
  failure_threshold: z
    .number()
    .int()
    .positive().max(0xffff_ffff)
    .optional()
    .describe("Consecutive failures before the breaker trips. Default 5."),
  cool_down_seconds: z
    .number()
    .finite().positive().max(365 * 24 * 3600)
    .optional()
    .describe("How long the breaker stays open. Default 30."),
  half_open_max_calls: z
    .number()
    .int()
    .positive().max(0xffff_ffff)
    .optional()
    .describe("Calls admitted in half-open. Default 1."),
  protected_slo_target: z
    .number()
    .gt(0)
    .lt(1)
    .optional()
    .describe("Optional context; a target alone cannot determine a consecutive-failure threshold."),
}).strict();

const ComposeSchema = z.object({
  service_name: z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f\u2028\u2029]*$/),
  rps: z.number().finite().min(1 / (365 * 24 * 3600)),
  protected_slo_target: z.number().gt(0).lt(1),
  expected_concurrency: z.number().finite().nonnegative().optional(),
}).strict();

export function registerTools(): void {
  tools.length = 0;

  tools.push({
    name: "compute_slo_burn",
    description:
      "Compute SLO burn rate and error budget from counts, plus single-window exhaustion and alert-tier estimates. " +
      "Ratio and burn calculations mirror slo-budget-tracker; this is not a multi-window paging decision.",
    inputSchema: zodToJsonSchema(SLOBurnSchema),
    handler: (args) => {
      const parsed = SLOBurnSchema.parse(args);
      return computeBurn(parsed);
    },
  });

  tools.push({
    name: "design_rate_limiter",
    description:
      "Given rps + burst_factor, return token-bucket sizing and Python/Rust integration examples " +
      "for rate-limit-shield (Python) and reliability-toolkit (Rust). Review before use.",
    inputSchema: zodToJsonSchema(RateLimiterSchema),
    handler: (args) => {
      const parsed = RateLimiterSchema.parse(args);
      return designRateLimiter(parsed);
    },
  });

  tools.push({
    name: "design_circuit_breaker",
    description:
      "Given failure_threshold + cool_down + half_open_max_calls, return a sanity-checked breaker " +
      "config with Python and Rust examples. An SLO target alone cannot validate the threshold " +
      "without request volume and failure-pattern evidence.",
    inputSchema: zodToJsonSchema(BreakerSchema),
    handler: (args) => {
      const parsed = BreakerSchema.parse(args);
      return designCircuitBreaker(parsed);
    },
  });

  tools.push({
    name: "compose_reliability_pattern",
    description:
      "Given service_name + rps + protected_slo_target, return a proposed layered design and " +
      "Python/Rust setup examples. Retry, monitoring, and end-to-end call wiring require integration work.",
    inputSchema: zodToJsonSchema(ComposeSchema),
    handler: (args) => {
      const parsed = ComposeSchema.parse(args);
      return composePattern(parsed);
    },
  });
}

// ---------------------------------------------------------------------------
// Zod -> JSON Schema (minimal, sufficient for MCP's tool schema field).
// We don't pull in @anatine/zod-mock or zod-to-json-schema to keep deps tight.
// ---------------------------------------------------------------------------

function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const shape = schema.shape;
  for (const key of Object.keys(shape)) {
    const field = shape[key];
    if (!field) continue;
    properties[key] = zodTypeToJsonSchema(field);
    if (!field.isOptional()) {
      required.push(key);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function zodTypeToJsonSchema(type: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap optional/nullable/default once.
  if (type instanceof z.ZodOptional) {
    return zodTypeToJsonSchema(type.unwrap() as z.ZodTypeAny);
  }
  const description = type._def.description;
  if (type instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: "string", ...(description ? { description } : {}) };
    for (const check of type._def.checks) {
      if (check.kind === "min") out.minLength = check.value;
      if (check.kind === "max") out.maxLength = check.value;
      if (check.kind === "regex") out.pattern = check.regex.source;
    }
    return out;
  }
  if (type instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: "number" };
    if (description) out.description = description;
    for (const check of type._def.checks) {
      if (check.kind === "int") out.type = "integer";
      if (check.kind === "min") out[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
      if (check.kind === "max") out[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
    }
    return out;
  }
  if (type instanceof z.ZodBoolean) {
    return { type: "boolean", ...(description ? { description } : {}) };
  }
  if (type instanceof z.ZodArray) {
    return {
      type: "array",
      items: zodTypeToJsonSchema(type.element as z.ZodTypeAny),
      ...(description ? { description } : {}),
    };
  }
  if (type instanceof z.ZodObject) {
    return zodToJsonSchema(type as z.ZodObject<z.ZodRawShape>);
  }
  // Fallback: open shape.
  return { ...(description ? { description } : {}) };
}
