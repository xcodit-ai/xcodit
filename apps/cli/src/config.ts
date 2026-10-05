import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Production and development share this name; a dev machine points it at its own Caddy. */
export const DEFAULT_SERVER = process.env.XCODIT_SERVER ?? "https://api.xcodit.dev";

const dir = join(homedir(), ".xcodit");
const credsPath = join(dir, "credentials.json");

export interface Credentials {
  server: string;
  token: string;
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(credsPath)) return null;
  try {
    return JSON.parse(readFileSync(credsPath, "utf8")) as Credentials;
  } catch {
    return null;
  }
}

/** Plain file with owner-only permissions; OS keychain integration comes later. */
export function saveCredentials(creds: Credentials): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(credsPath, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

export function clearCredentials(): void {
  rmSync(credsPath, { force: true });
}

export function requireCredentials(): Credentials {
  const creds = loadCredentials();
  if (!creds) {
    console.error("Not logged in. Run: xcodit login");
    process.exit(1);
  }
  return creds;
}

// ---- UI preferences (~/.xcodit/config.json) ---------------------------------

const configPath = join(dir, "config.json");

export interface UiConfig {
  /** "dark" | "light"; anything else is ignored. */
  theme?: string;
}

export function loadUiConfig(): UiConfig {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as UiConfig;
  } catch {
    return {};
  }
}

export function saveUiConfig(patch: UiConfig): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify({ ...loadUiConfig(), ...patch }, null, 2) + "\n");
}
