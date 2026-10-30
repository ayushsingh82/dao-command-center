export type TriggerInput = {
  /** Current sleeve value, micro-USD. */
  equity: bigint;
  /** Original stake, micro-USD. */
  principal: bigint;
  /** Already banked (persisted by the banker). */
  banked: boolean;
  /** The ratio at which the stake is banked, in basis points (20_000 = 2x: gains equal the stake). */
  multipleBps: bigint;
};

/** Bank the stake once gains cover it: equity >= stake * multiple, and never twice. */
export function shouldBankStake({ equity, principal, banked, multipleBps }: TriggerInput): boolean {
  if (banked || principal <= 0n) return false;
  return equity * 10_000n >= principal * multipleBps;
}

/**
 * Fixed per-agent key, so a second tick cannot produce a second exit. `attempt` stays 0 unless the DAO
 * vetoed the first exit and chose to retry; each retry is its own deliberate, single operation.
 */
export function stakeKey(agentId: string, attempt = 0): string {
  return attempt === 0 ? `principal:${agentId}` : `principal:${agentId}:retry-${attempt}`;
}
