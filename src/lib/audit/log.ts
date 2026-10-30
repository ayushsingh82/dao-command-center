/** Values that survive JSON, so entries can be sent to the API and stored as they are. */
export type AuditData = Record<string, string | number | boolean | null | undefined | string[]>;

export type AuditEntry = {
  seq: number;
  at: string;
  kind: string;
  /** Which sleeve it is about, if any. */
  sleeveId?: string;
  /** The digest of the mandate in force when this happened. Anyone holding the mandate can recompute it. */
  mandateDigest: string;
  data: AuditData;
};

/**
 * The audit trail. Every entry carries the digest of the mandate in force, so each action can be traced to
 * the rules it ran under. Append-only; entries are never changed.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];

  constructor(
    private digest: () => string,
    private now: () => Date,
  ) {}

  record(kind: string, data: AuditData = {}, sleeveId?: string, at?: string): AuditEntry {
    const entry: AuditEntry = {
      seq: this.entries.length + 1,
      at: at ?? this.now().toISOString(),
      kind,
      sleeveId,
      mandateDigest: this.digest(),
      data,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Entries after `afterSeq`, oldest first. */
  list(afterSeq = 0, limit?: number): AuditEntry[] {
    const out = this.entries.filter((e) => e.seq > afterSeq);
    return limit === undefined ? out : out.slice(-limit);
  }

  ofKind(kind: string, sleeveId?: string) {
    return this.entries.filter((e) => e.kind === kind && (sleeveId === undefined || e.sleeveId === sleeveId));
  }

  /** Every entry, for saving. */
  all(): AuditEntry[] {
    return structuredClone(this.entries);
  }

  /** Put back entries saved earlier. Only into an empty log, so the trail stays one unbroken sequence. */
  restore(entries: AuditEntry[]) {
    if (this.entries.length) throw new Error("the audit log already has entries");
    this.entries = structuredClone(entries);
  }

  get length() {
    return this.entries.length;
  }
}
