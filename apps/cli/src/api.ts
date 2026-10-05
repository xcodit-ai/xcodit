import { CLIENT_VERSION_HEADER, DeviceCodeResponseSchema, DeviceTokenResponseSchema, MeResponseSchema, PolicyBundleSchema } from "@xcodit/shared";
import { GatewayClient, GatewayError } from "@xcodit/agent";
import type { Credentials } from "./config.js";
import { VERSION } from "./tui/banner.js";

export { GatewayError as ApiError };

/** The engine's connection to the server, identified as this release. */
export function gatewayFor(creds: Credentials): GatewayClient {
  return new GatewayClient({ ...creds, clientVersion: VERSION });
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new GatewayError(res.status, body);
  return body as T;
}

const clientHeaders = { [CLIENT_VERSION_HEADER]: VERSION };

export async function requestDeviceCode(server: string) {
  const res = await fetch(`${server}/api/device/code`, { method: "POST", headers: clientHeaders });
  return DeviceCodeResponseSchema.parse(await json(res));
}

export async function pollDeviceToken(server: string, deviceCode: string) {
  const res = await fetch(`${server}/api/device/token`, {
    method: "POST",
    headers: { ...clientHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  return DeviceTokenResponseSchema.parse(await json(res));
}

function authHeaders(creds: Credentials) {
  return { ...clientHeaders, Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" };
}

export async function getMe(creds: Credentials) {
  const res = await fetch(`${creds.server}/v1/me`, { headers: authHeaders(creds) });
  return MeResponseSchema.parse(await json(res));
}

export async function getPolicy(creds: Credentials) {
  const res = await fetch(`${creds.server}/v1/policy`, { headers: authHeaders(creds) });
  return PolicyBundleSchema.parse(await json(res));
}
