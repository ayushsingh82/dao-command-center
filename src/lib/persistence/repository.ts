import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry } from "@/lib/audit/log";
import type { CommandCenterState } from "@/lib/command-center/types";

export const PERSISTED_VERSION = 1;

/** Everything the command center needs to carry on after a restart. */
export type PersistedState = {
  version: typeof PERSISTED_VERSION;
  savedAt: string;
  /** The counter behind sleeve ids, so a restored center never reuses one. */
  seq: number;
  state: CommandCenterState;
  audit: AuditEntry[];
};

export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

/** Where the command center keeps its state between runs. */
export interface StateRepository {
  load(): Promise<PersistedState | null>;
  save(state: PersistedState): Promise<void>;
}

/** Refuses anything that is not a state this version wrote. A half-understood state must not be run. */
export function parsePersisted(raw: unknown): PersistedState {
  const p = raw as Partial<PersistedState> | null;
  if (!p || typeof p !== "object") throw new PersistenceError("saved state is not an object");
  if (p.version !== PERSISTED_VERSION) throw new PersistenceError(`saved state has version ${String(p.version)}; expected ${PERSISTED_VERSION}`);
  const s = p.state;
  if (
    !s ||
    typeof s.treasuryStableAtomic !== "string" ||
    !/^\d+$/.test(s.treasuryStableAtomic) ||
    !Array.isArray(s.sleeves) ||
    !Array.isArray(s.approvals) ||
    typeof s.mandateDigest !== "string"
  )
    throw new PersistenceError("saved state is missing the treasury, sleeves, approvals or mandate digest");
  if (!Array.isArray(p.audit)) throw new PersistenceError("saved state has no audit trail");
  p.audit.forEach((e, i) => {
    if (e.seq !== i + 1) throw new PersistenceError(`audit trail is broken at entry ${i + 1}`);
  });
  if (typeof p.seq !== "number" || p.seq < s.sleeves.length) throw new PersistenceError("saved state has a bad sleeve counter");
  return p as PersistedState;
}

/** Keeps the last save in memory. For tests, and for a center that does not need to survive a restart. */
export class MemoryRepository implements StateRepository {
  private saved: string | null = null;
  saves = 0;

  async load() {
    return this.saved === null ? null : parsePersisted(JSON.parse(this.saved));
  }
  async save(state: PersistedState) {
    this.saved = JSON.stringify(state);
    this.saves++;
  }
}

/**
 * One JSON file. Written to a temporary file and renamed over the real one, so a crash mid-save leaves the
 * previous state intact rather than half a file. The file holds each sleeve's grant, so it is readable by
 * its owner only.
 */
export class FileRepository implements StateRepository {
  constructor(private path: string) {}

  async load() {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      return parsePersisted(JSON.parse(text));
    } catch (e) {
      if (e instanceof PersistenceError) throw e;
      throw new PersistenceError(`saved state at ${this.path} is not valid JSON`);
    }
  }

  async save(state: PersistedState) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
