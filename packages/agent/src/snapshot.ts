import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { displayPath } from "./paths.js";

interface FileState {
  existed: boolean;
  content?: Buffer;
}

/**
 * Per-turn file snapshots so a turn's edits can be undone without git.
 * Shell side effects are not covered; the UI says so.
 */
export class SnapshotStack {
  private turns: Map<string, FileState>[] = [];
  private current: Map<string, FileState> | null = null;

  constructor(private cwd: string) {}

  beginTurn(): void {
    this.current = new Map();
  }

  endTurn(): void {
    if (this.current && this.current.size) this.turns.push(this.current);
    this.current = null;
  }

  /** Capture a file's state before its first modification in this turn. */
  async capture(absPath: string): Promise<void> {
    if (!this.current || this.current.has(absPath)) return;
    const content = await readFile(absPath).catch(() => null);
    this.current.set(absPath, content ? { existed: true, content } : { existed: false });
  }

  /** Absolute paths modified so far in the current turn. */
  changedFiles(): string[] {
    return this.current ? [...this.current.keys()] : [];
  }

  get undoableTurns(): number {
    return this.turns.length;
  }

  /** Restore the most recent turn's files. Returns what was restored. */
  async undo(): Promise<string[]> {
    const turn = this.turns.pop();
    if (!turn) return [];
    const restored: string[] = [];
    for (const [abs, state] of turn) {
      if (state.existed && state.content) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, state.content);
        restored.push(`restored ${displayPath(this.cwd, abs)}`);
      } else {
        await rm(abs, { force: true });
        restored.push(`removed ${displayPath(this.cwd, abs)}`);
      }
    }
    return restored;
  }
}
