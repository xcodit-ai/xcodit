import { z } from "zod";
import { ROLES } from "./roles";

/**
 * Every client request carries its version here, so the server can turn away a
 * release it no longer supports with a clear message instead of a broken run.
 */
export const CLIENT_VERSION_HEADER = "x-xcodit-client";

/** OpenAI-compatible message shapes (the subset the agent uses). */
export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

export const MessageSchema = z.union([
  z.object({ role: z.literal("system"), content: z.string() }),
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({
    role: z.literal("assistant"),
    content: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  }),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: z.string() }),
]);
export type Message = z.infer<typeof MessageSchema>;

export const ToolDefSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }),
});
export type ToolDef = z.infer<typeof ToolDefSchema>;

/** POST /v1/chat request body. */
export const ChatRequestSchema = z.object({
  role: z.enum(ROLES),
  messages: z.array(MessageSchema).min(1),
  tools: z.array(ToolDefSchema).optional(),
  tool_choice: z.union([z.literal("auto"), z.literal("none"), z.literal("required")]).optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().default(true),
  /** Client-generated id so usage can be grouped per agent session. */
  session_id: z.string().max(128).optional(),
  /** Ask the gateway to search the web for this turn. */
  web: z.object({ max_results: z.number().int().min(1).max(10).optional() }).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** GET /v1/policy response: the non-secret routing bundle the agent may display. */
export const PolicyBundleSchema = z.object({
  version: z.number().int(),
  tier: z.string(),
  roles: z.record(z.enum(ROLES), z.object({ models: z.array(z.string()).min(1) })),
});
export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;

/** Device authorization flow (RFC 8628 shaped). */
export const DeviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;

export const DeviceTokenResponseSchema = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("approved"), token: z.string() }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("denied") }),
]);
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;

export const MeResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  tier: z.string(),
  usage_this_month_usd: z.number(),
  allowance_usd: z.number().nullable(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
