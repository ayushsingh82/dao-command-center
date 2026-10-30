import { z } from "zod";
import { OwnerActionSchema } from "@/lib/governance/schema";
import type { OwnerAction } from "@/lib/governance/types";
import { canonicalJson, sha256Hex } from "@/lib/dao/hash";

/**
 * How a decision of the command center becomes a Sputnik proposal. The DAO consents with a proposal of kind
 * `Vote`, which executes nothing on chain. Its description commits to exactly one action and one DAO:
 *
 *     <one line saying what it is, for the people voting>
 *     dao-command-center/v1
 *     {"dao":"…","scope":"…","by":"…","action":{…},"digest":"<sha256 of the action>"}
 *
 * The command center reads the action back from the chain, never from a request, and only acts on a
 * proposal the DAO's own voting has approved. The digest is checked so a description edited after the fact
 * (it cannot be, but a bug could) never runs as something else; the DAO account is checked so a consent
 * approved in one DAO cannot drive another's command center; the scope tells apart command centers that
 * share a DAO.
 */

export const CONSENT_PREFIX = "dao-command-center/v1";

const Terms = z.object({
  dao: z.string().min(1),
  scope: z.string(),
  by: z.string(),
  action: OwnerActionSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type Consent = { dao: string; scope: string; by: string; action: OwnerAction; digest: string; summary: string };

export const actionDigest = (action: OwnerAction) => sha256Hex(canonicalJson(action));

/** The proposal description for `action`. The summary is kept to one line. */
export function consentDescription(a: { dao: string; scope?: string; by: string; action: OwnerAction; summary: string }): string {
  const summary = a.summary.replace(/\s+/g, " ").trim().slice(0, 200) || a.action.type;
  const terms = { dao: a.dao, scope: a.scope ?? "", by: a.by, action: a.action, digest: actionDigest(a.action) };
  return `${summary}\n${CONSENT_PREFIX}\n${canonicalJson(terms)}`;
}

/** The consent a description carries, or null if it is not one of ours, is for another DAO or scope, or does not check out. */
export function parseConsent(description: string, expect: { dao: string; scope?: string }): Consent | null {
  const lines = description.split("\n");
  if (lines.length !== 3 || lines[1] !== CONSENT_PREFIX) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(lines[2]!);
  } catch {
    return null;
  }
  const parsed = Terms.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;
  if (t.dao !== expect.dao || t.scope !== (expect.scope ?? "")) return null;
  if (t.digest !== actionDigest(t.action)) return null;
  return { ...t, summary: lines[0]! };
}
