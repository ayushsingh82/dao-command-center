import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * What the command center did with each approved proposal. The chain says a proposal was approved; only this
 * says it was run. Without it a restart would run every approved proposal again, so it must be kept: use the
 * file ledger for anything but a test.
 */
export type LedgerEntry = { status: "executed" | "failed"; at: string; error?: string };

export interface ProposalLedger {
  get(id: string): Promise<LedgerEntry | undefined>;
  put(id: string, entry: LedgerEntry): Promise<void>;
}

export class MemoryLedger implements ProposalLedger {
  private entries = new Map<string, LedgerEntry>();
  async get(id: string) {
    const e = this.entries.get(id);
    return e && { ...e };
  }
  async put(id: string, entry: LedgerEntry) {
    this.entries.set(id, { ...entry });
  }
}

/** One JSON file, written to a temporary file and renamed, so a crash leaves the last good state. */
export class FileLedger implements ProposalLedger {
  private cache: Record<string, LedgerEntry> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private path: string) {}

  private async load() {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8")) as Record<string, LedgerEntry>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.cache = {};
    }
    return this.cache;
  }

  async get(id: string) {
    const e = (await this.load())[id];
    return e && { ...e };
  }

  async put(id: string, entry: LedgerEntry) {
    const all = await this.load();
    all[id] = { ...entry };
    const data = JSON.stringify(all);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
    });
    await this.writing;
  }
}
