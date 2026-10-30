# Architecture

How the pieces fit together. Details live in `backend-overview.md` (guarantees, tests), `api-reference.md` (routes) and `dao-live.md` (running on a real DAO).

## The idea in one line

A DAO signs its treasury rules once (the **mandate**), strategy agents run inside capped **sleeves**, large or risky moves wait in an **approvals queue** for a council vote, and a **kill switch** freezes everything.

## Layers

```
 Frontend (NOT BUILT YET)             overview, mandate, sleeves, approvals, kill switch
        |  JSON
 Next.js routes  src/app/api          thin: validate, call, return JSON, map errors to status codes
        |
 CommandCenter  src/lib/command-center/service.ts
   mandate, sleeves, approvals queue, ticks, kill switch, resume, retry, attack test, books, snapshot
        |
 Domain pieces
   mandate/     rules, validation, canonical form + digest, policy builder, policy diff
   strategy/    Strategy interface, trend, hold; Trader (decide, quote, swap, hold a swap for the DAO)
   runner/      StakeBanker (bank the stake once, crash-safe), events, state store
   governance/  proposals and council votes (mock, or Sputnik behind the same interface)
   audit/       append-only log; every entry carries the mandate digest
   risk/        fail-closed pricing, trigger, idempotency keys
   persistence/ state saved after every change (memory or atomic JSON file)
        |
 Two seams, each with a mock and a live implementation
   AgentClient   MockAgentApi        <->  LiveAgentApi  (NEAR Intents Agent API, SDK 0.7.2)
   Governance    MockGovernance      <->  SputnikGovernance + DAO signer (MPC, v1.signer)
```

## Mock vs live

| Seam | Mock (default, tested) | Live (built, not yet run against real services) |
|---|---|---|
| Agent API | `src/lib/agent-api/mock.ts` | `src/lib/agent-api/live.ts` |
| DAO votes | `src/lib/governance/mock.ts` | `src/lib/dao/` (Sputnik client, signer, funder) |
| Chain reads | audit trail vs API history | FastNear finder, RPC reader (`src/lib/dao/live.ts`) |

The Sputnik code has also run against the real Sputnik DAO v2 contract in a local NEAR sandbox (`npm run test:sandbox`).

## Key flows

- **Open a sleeve:** propose -> mandate check -> vote -> mandate check again -> fund from treasury -> grant to the strategy agent.
- **Bank the stake:** when gains cover the sleeve's stake, withdraw the stake once under a fixed idempotency key, then seal the policy with a passed proposal.
- **Risky trade:** a swap that adds risk over the threshold becomes an approval request; risk-reducing trades go straight out.
- **Kill switch:** freeze policy, revoke grants, cancel requests. Resume is a vote and only issues new grants.
- **Reconcile:** compare the API's balances with its operation history and our audit trail; flag anything unexplained.

## Where things live

| Path | Contents |
|---|---|
| `src/app/api/` | 21 JSON routes |
| `src/lib/` | all domain code (see layers above) |
| `contracts/mock-signer/` | Rust mock of the MPC signer for sandbox tests |
| `tests/sandbox/` | tests against the real Sputnik contract |
| `scripts/` | `simulate.mts` (full story on the mock), `live-check.mts`, `build-contracts.sh` |
| `docs/` | all project documentation |
| `PLAN.md` | one-page plan at the repo root |
