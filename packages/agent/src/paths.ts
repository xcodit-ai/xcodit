import { isAbsolute, relative, resolve, sep } from "node:path";

/** Resolves a model-supplied path against cwd and refuses anything outside it. */
export function resolveInside(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  // Say where the fence is. Told only that it failed, a model tries `..`,
  // `../..`, and then the same thing through the shell.
  throw new Error(
    `Path is outside the project directory: ${p}. The project is ${cwd.split(sep).join("/")} ` +
      `and nothing above it can be read. Ask the user to start xcodit there if you need it.`,
  );
}

export function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  return rel ? rel.split(sep).join("/") : ".";
}

/** Keep the head and tail so both the start and the final error lines survive. */
export function truncate(text: string, max = 40_000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.4));
  return `${head}\n\n[... ${text.length - max} characters truncated ...]\n\n${tail}`;
}
