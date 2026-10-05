import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** Optional per-project settings in .xcodit/config.json. */
export const ProjectConfigSchema = z.object({
  /** Commands run after the agent changes files; overrides auto-discovery. */
  verify: z.array(z.string()).optional(),
  /** Cross-model review of the diff after verification. */
  review: z.boolean().optional(),
  /** Seconds each verify command may run. */
  verify_timeout: z.number().int().positive().optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  const text = await readFile(join(cwd, ".xcodit", "config.json"), "utf8").catch(() => null);
  if (!text) return {};
  const parsed = ProjectConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`.xcodit/config.json: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}
