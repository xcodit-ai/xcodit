/**
 * Agent roles. The server maps each role to an ordered list of models
 * (primary + fallbacks) per plan tier; the agent never names a model directly.
 */
export const ROLES = ["planner", "implementer", "navigator", "reviewer", "compactor"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  planner: "Reads the task and codebase, produces a step plan with acceptance criteria.",
  implementer: "Makes the code changes with tools.",
  navigator: "Cheap model for search, file summarization and repo orientation.",
  reviewer: "Reviews diffs; deliberately a different vendor from the implementer.",
  compactor: "Summarizes long contexts into file-backed state.",
};

/**
 * User-facing model family. Each specialist is presented as an xcodit model;
 * the upstream routing behind it is an internal detail (admin only).
 */
export interface SpecialistInfo {
  /** Model name shown to users, e.g. in receipts and `xcodit policy`. */
  model: string;
  label: string;
  tagline: string;
  description: string;
  /** Short glyph for cards and terminal output. */
  glyph: string;
}

export const SPECIALISTS: Record<Role, SpecialistInfo> = {
  planner: {
    model: "relay-plan",
    label: "Planner",
    tagline: "Reasons before anything changes.",
    description: "Explores the repository read-only, then writes a step-by-step plan with acceptance criteria that you approve or annotate before a single file is touched.",
    glyph: "◇",
  },
  implementer: {
    model: "relay-build",
    label: "Builder",
    tagline: "Small, verified edits.",
    description: "Works with six tools — read, edit, write, shell, grep, glob — makes minimal changes, runs your checks, and delegates exploration so its own context stays sharp.",
    glyph: "▣",
  },
  navigator: {
    model: "relay-scout",
    label: "Scout",
    tagline: "Finds things fast, cheaply.",
    description: "A lightweight specialist for search and orientation. The Builder hands it questions like “where is X handled?” and gets back one answer instead of fifty file reads.",
    glyph: "◎",
  },
  reviewer: {
    model: "relay-judge",
    label: "Judge",
    tagline: "Never reviews its own work.",
    description: "Reads the finished diff cold, with the task and the verification result, and returns a strict verdict. Blocking issues go back to the Builder before you see the change.",
    glyph: "⚖︎",
  },
  compactor: {
    model: "relay-fold",
    label: "Fold",
    tagline: "Long sessions, short memory.",
    description: "When a session grows past its context budget, Fold rewrites the older part into working notes — goals, decisions, files touched, open problems — so nothing important is lost.",
    glyph: "≡",
  },
};

export const MODEL_FAMILY = "Relay";

/** Look up a specialist by its public model name. */
export function roleForModel(model: string): Role | undefined {
  return (Object.keys(SPECIALISTS) as Role[]).find((r) => SPECIALISTS[r].model === model);
}
