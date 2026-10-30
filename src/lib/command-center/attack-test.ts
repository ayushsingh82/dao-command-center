import type { AgentClient } from "@/lib/agent-api/types";
import type { AttackCheck, SleeveRecord } from "@/lib/command-center/types";
import { AgentApiError } from "@/lib/errors";
import type { Mandate } from "@/lib/mandate/mandate";
import { stakeKey } from "@/lib/risk/trigger";

export type AttackContext = {
  api: AgentClient;
  mandate: Mandate;
  sleeve: SleeveRecord;
  now: Date;
  grantTtlMs: number;
};

const NOT_ALLOWED_ASSET = "nep141:not-on-the-allowlist";

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "allowed";
  } catch (e) {
    return e instanceof AgentApiError ? e.code : `unexpected: ${String(e)}`;
  }
}

/**
 * Everything a compromised strategy might try, run against a sleeve's real grant and policy. Each probe is
 * built so the policy must refuse it before anything moves; the one exception is the idempotent replay,
 * which must hand back the original exit and create nothing.
 *
 * A frozen sleeve is tested differently: its old grant is revoked, and a brand-new grant must still be
 * stopped by the freeze.
 */
export async function runAttackTest({ api, mandate: m, sleeve: s, now, grantTtlMs }: AttackContext): Promise<AttackCheck[]> {
  const checks: AttackCheck[] = [];
  const add = (id: string, label: string, expected: string, got: string) => checks.push({ id, label, expected, got, pass: expected === got });
  let n = 0;
  const key = () => `attack:${s.id}:${++n}`;
  const stake = BigInt(s.stakeAtomic);
  const withdrawBody = (over: Partial<{ asset: string; amount: string; chain: string; recipient: string; memo: string | null }> = {}) => ({
    asset: m.stableAsset, amount: stake.toString(), chain: m.safe.chain, recipient: m.safe.address, ...over,
  });
  const swapBody = (over: Partial<{ origin_asset: string; destination_asset: string; amount: string }> = {}) => ({
    origin_asset: m.stableAsset, destination_asset: s.riskAsset, amount: (stake / 100n || 1n).toString(), ...over,
  });

  if (s.status === "frozen") {
    const old = api.forGrant(s.grantToken);
    add("frozen-old-swap", "Trade with the sleeve's old grant", "agent_grant_required", await code(() => old.swap(s.agentId, swapBody(), { idempotencyKey: key() })));
    add("frozen-old-withdraw", "Withdraw with the sleeve's old grant", "agent_grant_required", await code(() => old.withdraw(s.agentId, withdrawBody(), { idempotencyKey: key() })));

    // The freeze must hold against any credential, including one issued after the fact.
    const fresh = await api.issueGrant(s.agentId, `attack-test:${s.id}`, new Date(now.getTime() + Math.min(grantTtlMs, 300_000)));
    const g = api.forGrant(fresh.token);
    add("frozen-new-swap", "Trade with a freshly issued grant", "wallet_frozen", await code(() => g.swap(s.agentId, swapBody(), { idempotencyKey: key() })));
    add("frozen-new-withdraw", "Withdraw to the safe with a freshly issued grant", "wallet_frozen", await code(() => g.withdraw(s.agentId, withdrawBody(), { idempotencyKey: key() })));
    add("frozen-new-transfer", "Transfer out with a freshly issued grant", "wallet_frozen", await code(() => g.transfer(s.agentId, { asset: m.stableAsset, amount: "1", recipient: "owner.near" })));
    await api.revokeGrant(s.agentId, fresh.token);
    return checks;
  }

  const g = api.forGrant(s.grantToken);
  // Once the stake is banked and the policy sealed, `withdraw` is gone: every withdrawal is refused as an action.
  const wd = (expected: string) => (s.sealed ? "policy_action_denied" : expected);

  add("transfer-out", "Transfer funds out of the agent", "policy_action_denied", await code(() => g.transfer(s.agentId, { asset: m.stableAsset, amount: "1", recipient: "owner.near" })));
  add("other-address", "Withdraw to an address that is not the safe", wd("policy_destination_denied"),
    await code(() => g.withdraw(s.agentId, withdrawBody({ recipient: "0xATTACKER" }), { idempotencyKey: key() })));
  add("other-chain", "Withdraw to the safe address on another chain", wd("policy_destination_denied"),
    await code(() => g.withdraw(s.agentId, withdrawBody({ chain: "near" }), { idempotencyKey: key() })));
  add("memo", "Withdraw with a memo the policy does not list", wd("policy_destination_denied"),
    await code(() => g.withdraw(s.agentId, withdrawBody({ memo: "sneaky" }), { idempotencyKey: key() })));
  add("other-asset", "Withdraw an asset outside the allowlist", wd("policy_asset_denied"),
    await code(() => g.withdraw(s.agentId, withdrawBody({ asset: NOT_ALLOWED_ASSET }), { idempotencyKey: key() })));
  add("over-cap", "Withdraw more than the stake in one go", wd("policy_limit_exceeded"),
    await code(() => g.withdraw(s.agentId, withdrawBody({ amount: (stake + 1n).toString() }), { idempotencyKey: key() })));
  add("swap-other-asset", "Swap into an asset outside the allowlist", "policy_asset_denied",
    await code(() => g.swap(s.agentId, swapBody({ destination_asset: NOT_ALLOWED_ASSET }), { idempotencyKey: key() })));
  add("swap-over-cap", "Swap more than the per-transaction cap", "policy_limit_exceeded",
    await code(() => g.swap(s.agentId, swapBody({ amount: (stake + 1n).toString() }), { idempotencyKey: key() })));

  // Replaying the stake exit must return the original operation and send nothing new.
  if (s.runner.withdrawalId) {
    let replay: string;
    try {
      const op = await g.withdraw(s.agentId, withdrawBody(), { idempotencyKey: stakeKey(s.agentId, s.runner.attempt ?? 0) });
      replay = op.correlation_id === s.runner.withdrawalId ? "replay" : "new-operation";
    } catch (e) {
      replay = e instanceof AgentApiError ? e.code : String(e);
    }
    add("replay", "Replay the stake exit under the same key", "replay", replay);
  }

  const doomed = await api.issueGrant(s.agentId, `attack-test-revoked:${s.id}`, new Date(now.getTime() + 60_000));
  await api.revokeGrant(s.agentId, doomed.token);
  add("revoked-grant", "Use a revoked grant", "agent_grant_required", await code(() => api.forGrant(doomed.token).getBalances(s.agentId)));

  return checks;
}
