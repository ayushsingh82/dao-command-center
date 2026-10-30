import type { Policy } from "@/lib/policy/types";

export type PolicyChange = {
  /** Dotted path, for example `limits.per_transaction.nep141:usdc` or `budget.daily_usd`. */
  path: string;
  before: unknown;
  after: unknown;
};

function flatten(value: unknown, prefix: string, out: Map<string, unknown>) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) out.set(prefix, {});
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.set(prefix, value);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What changes between the policy in force and a proposed one, leaf by leaf. A missing policy diffs
 * against nothing, so every field shows as added. Used to show the DAO exactly what it is voting on.
 */
export function diffPolicies(before: Policy | null, after: Policy): PolicyChange[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  if (before) flatten(before, "", a);
  flatten(after, "", b);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const changes: PolicyChange[] = [];
  for (const path of paths) {
    const x = a.has(path) ? a.get(path) : undefined;
    const y = b.has(path) ? b.get(path) : undefined;
    if (!same(x, y)) changes.push({ path, before: x, after: y });
  }
  return changes;
}
