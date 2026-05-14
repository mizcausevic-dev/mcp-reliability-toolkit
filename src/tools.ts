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
  failures: z.number().int().nonnegative().describe("Failures in the window."),
  total: z.number().int().nonnegative().describe("Total observations in the window."),
  window_seconds: z.number().int().positive().describe("Window length in seconds."),
});

const RateLimiterSchema = z.object({
  rps: z.number().positive().describe("Steady-state requests per second the downstream should accept."),
  burst_factor: z
    .number()
    .min(1)
    .optional()
    .describe("Token bucket capacity = rps * burst_factor. Default 2."),
  expected_concurrency: z
    .number()
    .nonnegative()
    .optional()
    .describe("Typical concurrent callers; used to suggest a bulkhead size."),
});

const BreakerSchema = z.object({
  failure_threshold: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Consecutive failures before the breaker trips. Default 5."),
  cool_down_seconds: z
    .number()
    .positive()
    .optional()
    .describe("How long the breaker stays open. Default 30."),
  half_open_max_calls: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Calls admitted in half-open. Default 1."),
  protected_slo_target: z
    .number()
    .gt(0)
    .lt(1)
    .optional()
    .describe("If set, the breaker will sanity-check against the SLO error budget."),
});

const ComposeSchema = z.object({
  service_name: z.string().min(1),
  rps: z.number().positive(),
  protected_slo_target: z.number().gt(0).lt(1),
  expected_concurrency: z.number().nonnegative().optional(),
});

export function registerTools(): void {
  tools.length = 0;

  tools.push({
    name: "compute_slo_burn",
    description:
      "Compute SLO burn rate, error budget remaining, time-to-exhaustion, and a paging alert level " +
      "from raw observation counts. Mirrors the math in slo-budget-tracker.",
    inputSchema: zodToJsonSchema(SLOBurnSchema),
    handler: (args) => {
      const parsed = SLOBurnSchema.parse(args);
      return computeBurn(parsed);
    },
  });

  tools.push({
    name: "design_rate_limiter",
    description:
      "Given rps + burst_factor, return a sized token-bucket config plus drop-in Python and Rust " +
      "snippets that wire it into rate-limit-shield (Python) or reliability-toolkit (Rust).",
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
      "config with Python and Rust snippets. When protected_slo_target is given, the tool also flags " +
      "thresholds that look inconsistent with the SLO's error budget.",
    inputSchema: zodToJsonSchema(BreakerSchema),
    handler: (args) => {
      const parsed = BreakerSchema.parse(args);
      return designCircuitBreaker(parsed);
    },
  });

  tools.push({
    name: "compose_reliability_pattern",
    description:
      "Given service_name + rps + protected_slo_target, return the recommended layered stack — " +
      "rate-limiter → bulkhead → circuit-breaker → retry → SLO tracker — plus a Python and Rust " +
      "config snippet you can paste into the service.",
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
    return { type: "string", ...(description ? { description } : {}) };
  }
  if (type instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: "number" };
    if (description) out.description = description;
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
