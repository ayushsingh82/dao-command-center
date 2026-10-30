# Backend overview

What exists, how it fits together, what is real and what is mocked. For the routes themselves see `api-reference.md`.

## Layers

```
 Next.js routes (src/app/api)          thin: validate, call, return JSON; errors mapped to status codes
        |
 CommandCenter (src/lib/command-center/service.ts)
   mandate, sleeves, approvals queue, ticks, kill switch, resume, retry, attack test, books, snapshot
        |
 Domain pieces
   mandate/     rules, validation, canonical form + digest, policy builder, policy diff
   strategy/    Strategy interface, trend, hold; the Trader (decides, quotes, swaps, can hold a swap for the DAO)
   runner/      StakeBanker (banks the stake once, crash-safe, retry after a veto), events, state store
   governance/  Proposals and council votes (MockGovernance; a Sputnik implementation goes behind the same interface)
   audit/       Append-only log; every entry carries the mandate digest
   risk/        Fail-closed pricing, trigger, idempotency keys
        |
 AgentClient interface (src/lib/agent-api/types.ts)
   MockAgentApi today; a live NEAR Intents Agent API client goes behind the same interface
```

## What is real and what is mocked

| Piece | Today | Live later |
|---|---|---|
| Rules, sleeves, banking, approvals, kill switch, audit, books | Real code with tests | Unchanged |
| NEAR Intents Agent API | `MockAgentApi`: enforces grants, freeze, action/asset/destination allowlists, per-transaction caps, hourly rate, rolling USD budgets, owner-approval holds, the delay queue, idempotent replay, the 10-minute policy-edit cooldown | `LiveAgentApi` (`agent-api/live.ts`): built on the official SDK, tested on a fake network, never run against the service. Needs a DAO signer and a funder (`live-agent-api.md`) |
| DAO votes | `MockGovernance`: a council with a threshold, or auto-approve | `SputnikGovernance` (`dao/governance.ts`): `Vote` proposals on a real DAO, read back from the chain. The Agent API's owner actions are signed by the DAO through `v1.signer` (`dao/signer.ts`). See `dao-live.md` |
| Prices | `MockMarket`, set by hand | The Agent API's token catalog |
| Chain reads for reconciliation | Reconciles the API's own history against our audit trail | Add FastNear transfer records |
| State | Saved through a `StateRepository` (memory or an atomic, owner-only JSON file) when one is given; the dev API runs without one, so it still starts over | A database behind the same interface |
| Who is acting | A name the caller declares | Wallet signatures and the DAO's membership. (On a real DAO, votes are cast on chain by the members and the backend holds no member's key.) |

Checked against the SDK's types and README (version 0.7.2): the owner-approval hold (the API's `PENDING_APPROVAL`, cleared by an `approval_vote` intent; `HELD` is only this app's name for it) and the refusal codes `policy_asset_denied`, `policy_destination_denied`, `policy_action_denied`, `policy_limit_exceeded` and `spend_budget_exceeded`. Still invented by the mock and not confirmed anywhere: rolling 24 hour, 7 day and 30 day budget windows (the API has daily, weekly and monthly USD budgets), `min_amount_out_not_met`, `policy_change_throttled` and the 10 minute edit cooldown (from House Money's notes).

## Guarantees the tests check

- **A stake leaves once.** The stake is withdrawn under a fixed idempotency key; a crash between sending and recording replays the same operation. After banking, the policy is sealed (a passed proposal) so `withdraw` no longer exists.
- **Only gains are at risk after banking.** A 40% drawdown after banking leaves the treasury unchanged.
- **The mandate is enforced twice:** when a sleeve is proposed and again when the vote passes (it may have changed in between).
- **The runway is untouchable:** opening a sleeve can never push the treasury's stable balance below the floor, or the total at risk above the bucket.
- **Nothing acts on a bad price.** A missing or stale price, for any asset the strategy reads, halts the tick.
- **Risk-adding trades over the threshold wait for the DAO. Risk-reducing trades never do** (a sale into the stable asset goes straight out).
- **The kill switch acts at once and holds, on the mock:** frozen policy, revoked grants, cancelled requests, closed queue. A brand-new grant is still refused. Lifting it is a vote, on new grants only. (On a real DAO each freeze and revocation is a DAO signature; see `dao-live.md`.)
- **An attack test:** transfers out, other addresses, other chains, memos, other assets, over-cap withdrawals and swaps, replays and revoked grants are all refused.
- **Books close:** the API's balances match what its operation history implies, and every operation is in the audit trail. A rogue operation or an unexplained balance is flagged.
- **Every audit entry carries the digest of the mandate in force.**

## Run it

```sh
npm install
npm test                 # 244 tests
npm run simulate         # the whole story on the mock, with real votes; exits non-zero on any failure
npm run typecheck        # next typegen + tsc
npm run lint
npm run dev              # the API on http://localhost:3000/api/state
```

## Tests

| Area | File |
|---|---|
| Mandate rules, digest, policy builder, diff | `src/lib/mandate/*.test.ts` |
| Live Agent API client, through the real SDK on a fake network | `src/lib/agent-api/live.test.ts` |
| Sputnik client, governance, signer, funder, adapters | `src/lib/dao/*.test.ts` (61) |
| The live command center, assembled | `src/lib/command-center/live.test.ts` |
| The DAO code against the real Sputnik DAO contract | `tests/sandbox/sputnik.test.ts` (8; `npm run test:sandbox`) |
| Mock Agent API (policy layers, holds, budgets, freeze, veto) | `src/lib/agent-api/mock.test.ts` |
| Stake banker (crash safety, retry, frozen, stale price) | `src/lib/runner/banker.test.ts` |
| Trader (trend, floors, reserve, holding a swap for the DAO) | `src/lib/strategy/trader.test.ts` |
| Council votes | `src/lib/governance/mock.test.ts` |
| Mandate and opening sleeves | `src/lib/command-center/sleeves.test.ts` |
| A sleeve's whole life | `src/lib/command-center/lifecycle.test.ts` |
| Approvals queue, veto window, owner-approval sleeves | `src/lib/command-center/approvals.test.ts` |
| Kill switch, resume, attack test | `src/lib/command-center/safety.test.ts` |
| Books, mandate changes, vetoed exit and retry | `src/lib/command-center/books-and-mandate.test.ts` |
| The end-to-end story | `src/lib/command-center/story.test.ts` |
| HTTP: status codes, validation, flows | `src/app/api/api.test.ts` |

## Limits to know about

- **No authentication.** See the note in `api-reference.md`. Mock only.
- **Nothing has called a live service.** The live Agent API client exists and is tested on a fake network; it has never run against the real one. There is no Sputnik DAO or FastNear client yet.
- **Restart.** With a repository the sleeves, approvals, mandate and audit trail come back. A trend strategy's running average starts again, and a swap that was waiting on the DAO is asked for again on the next tick. The dev API route runs without a repository, and the mock Agent API and council are not saved, so only a live deployment restores a meaningful whole. The saved file holds each sleeve's grant: treat it as a secret.
- **Every owner action on a real DAO is a vote.** The mock hides the cost by auto-approving; with votes switched on it models the friction, but it cannot say how many votes the real API needs per agent (that is still to measure).
- **The kill switch is instant only on the mock.** On a real DAO freezing and revoking are owner actions, so each is a DAO signature, one after another, within the Agent API's few-minute window. See `dao-live.md`.
- **House Money's strategy has only seen scripted prices.** Nothing here promises returns.
- **Ported code.** The policy, risk, strategy, trader and banker code started as House Money's (a private repository). The trader had a bug in the port source: it checked that the risk asset had a price but not that the price was fresh. Fixed here, with a regression test.
- **Fast markets defeat the slippage floor.** A swap fills after the policy's delay, at the price then. If the price moves further than `slippageBps` in that time it fails and is asked again; a faster-than-delay rally shows this in the demo.
