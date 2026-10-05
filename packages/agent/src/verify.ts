import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { bashTool } from "./tools/bash.js";
import type { ToolContext } from "./types.js";
import { truncate } from "./paths.js";

export interface CheckResult {
  command: string;
  passed: boolean;
  output: string;
  ms: number;
}

export interface VerifyResult {
  checks: CheckResult[];
  passed: boolean;
  /** Compact report suitable for feeding back to the model. */
  report: string;
}

const exists = (p: string) => access(p).then(() => true, () => false);

/**
 * Work out what "the project's checks" are. Conservative on purpose: only
 * scripts that exist, tests only when they are not watch-mode.
 */
export async function discoverChecks(cwd: string): Promise<string[]> {
  const pkgText = await readFile(join(cwd, "package.json"), "utf8").catch(() => null);
  if (pkgText) {
    const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const runner = (await exists(join(cwd, "pnpm-lock.yaml"))) ? "pnpm" : (await exists(join(cwd, "yarn.lock"))) ? "yarn" : (await exists(join(cwd, "bun.lockb"))) ? "bun" : "npm";
    const run = (name: string) => (runner === "npm" ? `npm run ${name}` : `${runner} ${name}`);
    const out: string[] = [];
    for (const name of ["typecheck", "type-check", "tsc", "lint", "test"]) {
      const s = scripts[name];
      if (!s) continue;
      if (name === "test" && /watch|--ui|jest\s*$/.test(s) && !/--run|CI/.test(s)) continue;
      out.push(run(name));
      if (name === "typecheck" || name === "type-check" || name === "tsc") continue;
    }
    if (!out.some((c) => /typecheck|type-check|tsc/.test(c)) && (await exists(join(cwd, "tsconfig.json")))) {
      out.unshift(runner === "npm" ? "npx tsc --noEmit" : `${runner} exec tsc --noEmit`);
    }
    return out;
  }
  if (await exists(join(cwd, "Cargo.toml"))) return ["cargo check --all-targets", "cargo test"];
  if (await exists(join(cwd, "go.mod"))) return ["go build ./...", "go vet ./...", "go test ./..."];
  if ((await exists(join(cwd, "pyproject.toml"))) || (await exists(join(cwd, "pytest.ini"))) || (await exists(join(cwd, "tests")))) {
    return ["python -m pytest -q -x"];
  }
  return [];
}

export async function runChecks(cwd: string, commands: string[], timeoutMs: number, signal?: AbortSignal): Promise<VerifyResult> {
  const ctx: ToolContext = { cwd, mode: "full-auto", askPermission: async () => true, snapshotFile: async () => {}, signal };
  const checks: CheckResult[] = [];
  for (const command of commands) {
    const started = Date.now();
    const r = await bashTool.execute({ command, timeout_ms: timeoutMs }, ctx);
    checks.push({ command, passed: !r.isError, output: r.content, ms: Date.now() - started });
    if (signal?.aborted) break;
  }
  const failed = checks.filter((c) => !c.passed);
  const report = failed.length
    ? failed.map((c) => `$ ${c.command}\n${truncate(c.output, 12_000)}`).join("\n\n")
    : checks.map((c) => `$ ${c.command} — ok (${c.ms}ms)`).join("\n");
  return { checks, passed: failed.length === 0, report };
}
