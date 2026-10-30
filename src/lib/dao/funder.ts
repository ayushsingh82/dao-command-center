import { AgentApiError } from "@/lib/errors";
import type { Funder } from "@/lib/agent-api/live";
import type { SputnikDao } from "@/lib/dao/sputnik";
import type { FunctionCallKind, NearSender, ProposalKind } from "@/lib/dao/types";

const STORAGE_DEPOSIT = "1250000000000000000000"; // 0.00125 NEAR: one NEP-145 registration
const GAS = "30000000000000";

const call = (method: string, args: object, deposit: string) => ({ method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit, gas: GAS });

/**
 * The proposal that moves `amount` of a token from the DAO to an agent's deposit address. Deposit addresses
 * start unregistered on the token, so the transfer registers them first (NEP-145).
 */
export function fundingKind(tokenContract: string, depositAddress: string, amount: string): FunctionCallKind {
  return {
    FunctionCall: {
      receiver_id: tokenContract,
      actions: [
        call("storage_deposit", { account_id: depositAddress, registration_only: true }, STORAGE_DEPOSIT),
        call("ft_transfer", { receiver_id: depositAddress, amount }, "1"),
      ],
    },
  };
}

export type DaoFunderOptions = {
  dao: SputnikDao;
  /** Files the proposal (and, with `oneClick`, approves it). Must be allowed to add `call` proposals. */
  sender: NearSender;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** The longest to wait when the deposit has no expiry of its own. Default one hour. */
  maxWaitMs?: number;
  oneClick?: boolean;
  /** Told when a funding proposal is filed, so a screen can show members what to approve. */
  onProposal?: (p: { proposalId: number; dao: string; description: string }) => void;
};

const ENDED = new Set(["Rejected", "Removed", "Expired", "Moved", "Failed"]);

/**
 * Funds an agent from the DAO's treasury. The money is the DAO's, so this is its own decision: a proposal that
 * calls the token contract, approved by the council. It waits for the approval, then once more to be sure the
 * transfer did not fail (the contract marks a proposal Failed after the fact). The Agent API's own deposit
 * status is the final word on whether the money arrived.
 */
export class DaoFunder implements Funder {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: DaoFunderOptions) {
    this.now = o.now ?? (() => new Date());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async fund(t: { agentId: string; asset: string; amount: string; depositAddress: string; memo: string | null; expiresAt: string | null }): Promise<void> {
    if (t.memo) throw new AgentApiError("funding_memo_unsupported", "this deposit address needs a memo, which a token transfer from the DAO cannot carry", 400);
    if (!/^nep141:/.test(t.asset)) throw new AgentApiError("funding_asset_unsupported", `the DAO funds NEP-141 tokens only, not ${t.asset}`, 400);
    const token = t.asset.slice("nep141:".length);
    const kind = fundingKind(token, t.depositAddress, t.amount);
    const description = `Fund agent ${t.agentId}: ${t.amount} units of ${token} to its deposit address ${t.depositAddress}`;
    const id = await (this.o.oneClick ? this.o.dao.fileAndApprove(this.o.sender, description, kind) : this.o.dao.file(this.o.sender, description, kind));
    this.o.onProposal?.({ proposalId: id, dao: this.o.dao.accountId, description });
    await this.waitApproved(id, Date.parse(t.expiresAt ?? "") || this.now().getTime() + (this.o.maxWaitMs ?? 3_600_000));
  }

  private async waitApproved(id: number, deadline: number): Promise<void> {
    const poll = this.o.pollMs ?? 3_000;
    let approvedOnce = false;
    for (;;) {
      const p = await this.o.dao.proposal(id);
      if (p && ENDED.has(p.status)) throw new AgentApiError("funding_refused", `the DAO's funding proposal ${id} ended ${p.status}`, 409);
      if (p?.status === "Approved") {
        if (approvedOnce) return; // still Approved a poll later: the transfer did not fail
        approvedOnce = true;
      }
      if (this.now().getTime() >= deadline) throw new AgentApiError("funding_expired", `the DAO did not approve funding proposal ${id} before the deposit expired`, 408);
      await this.sleep(poll);
    }
  }
}

/** The proposal that sends NEAR from the DAO to `receiver`: how the DAO's owner account is first funded. */
export function nearTransferKind(receiver: string, yocto: string): ProposalKind {
  return { Transfer: { token_id: "", receiver_id: receiver, amount: yocto } };
}
