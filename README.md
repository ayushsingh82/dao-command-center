# DAO Command Center

> A control room where a DAO sets its treasury rules once, lets AI agents run investment strategies inside them, and keeps the final say.

**Status:** the backend is built (244 tests, an end-to-end simulation, a real-server HTTP run) and runs on a mock Agent API and council. The Sputnik DAO client, the MPC owner signer and the funder have also run against the real Sputnik DAO contract in a local NEAR sandbox (8 tests). The frontend is not built yet, and nothing has called a live service or spent a real token. It builds on earlier prototypes (a treasury prototype and "House Money") that predate the hackathon.

**Tracks:** 12 Social Money · 1 Unstoppable DeFi · 6 AI Security & Defense · 4 Autonomous Business

## Overview

DAOs hold large treasuries but manage them by hand, one vote at a time. Handing money to an AI agent is risky, so most DAOs never try strategies, and a failed strategy puts the DAO's runway at stake.

DAO Command Center is one screen where a DAO signs its rules, lets strategy agents run inside capped sleeves, holds large moves for a vote, and can freeze everything with one action.

## What it does

- **Mandate:** the DAO signs its rules once: untouchable runway, a risk bucket, per-asset and USD caps, allowed assets and destinations, a delay before money leaves, and a schedule.
- **Strategy sleeves:** each strategy runs in its own capped slice of the risk bucket, so one bad strategy cannot touch the rest.
- **Bank the stake:** when a sleeve's gains cover what it started with, the starting amount returns to the treasury automatically, exactly once. After that the sleeve can only lose gains.
- **Approvals queue:** large or unusual moves wait for a DAO vote, with a veto window before money leaves.
- **Kill switch:** one action freezes the agent and revokes its access; every later spend attempt is refused. (Instant on the mock; on a real DAO each freeze and revocation is a DAO signature.)
- **Reconciled balances and audit trail:** public and confidential balances matched against the chain, with each action tied to the hash of the mandate it ran under.

## Architecture

```
 Browser (Next.js)
   mandate / sleeves / approvals / balances / kill switch
        |
        v
 Next.js server routes  ---->  Store (sleeves, runs, events)
        |
        v
 Adapters
   AgentApi (mock | live)  -> NEAR Intents Agent API
   Chain (reads)           -> FastNear transfers, NEAR RPC
   Dao (reads, votes)      -> Sputnik DAO / Trezu
   Signer (owner intents)  -> NEP-413 / NEP-366, DAO via MPC proposals
        |
        v
 Runner (strategy loop): price check -> decide -> act inside policy
```

## NEAR protocols

| Protocol | Role | Status in this app |
|---|---|---|
| NEAR Intents Agent API | Policies, grants, swaps, withdrawals, confidential balances, timelocks, owner approvals | Mock built and tested; live client built on the SDK and tested on a fake network, never run against the service |
| Sputnik DAO | The DAO that owns the agent and votes on owner actions | Mock council, and a client for the real contract (run in a sandbox against the real Sputnik DAO v2) |
| NEAR MPC signing | Lets a DAO sign owner intents through a proposal | Built (`src/lib/dao/signer.ts`); run against the real Sputnik contract with a stand-in signer. The real `v1.signer` has not been called |
| Trezu | DAO treasury front end | Referenced; not integrated by us |
| FastNear | Finds the DAO's signatures on chain; transfer reads for reconciliation | Signature finder written (fake HTTP only). Reconciliation reads not started |

Details and the status levels are in [`docs/protocols-integrated.md`](docs/protocols-integrated.md).

## Built from

| Piece | Source |
|---|---|
| Signed policies, caps, confidential balances, reconciled books, run report | Treasury prototype |
| Bank-the-stake logic, trend strategy, trader, policy builder, attack test, mock agent | House Money |
| DAO approval for machine credentials | Treasury pull request #8 |

## Tech stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4
- zod for request validation; the test runner is Node's built-in one, run through tsx
- Ported from House Money: the policy, risk, strategy, trader and banker code

## Getting started

```sh
npm install
npm test             # 244 tests
npm run simulate     # the whole product on the mock, with real council votes
npm run test:sandbox # 8 tests of the DAO code against the real Sputnik contract (run ./scripts/build-contracts.sh first)
npm run dev          # the JSON API at http://localhost:3000/api/state
```

The routes are listed in [`docs/api-reference.md`](docs/api-reference.md); the page at <http://localhost:3000> is still the Next.js starter. The NEAR Intents Agent API SDK needs Node.js 24 or later. This project's `AGENTS.md` asks you to read the guide in `node_modules/next/dist/docs/` before writing code, because this Next.js version has breaking changes.

**Funds:** the Agent API has no test network, so any live run uses real funds. Use a dedicated low-value account and small amounts. The planned mock mode needs no funds.

## Project structure

```
src/
├── app/
│   ├── page.tsx            Next.js starter (frontend not built yet)
│   └── api/                21 JSON routes: state, mandate, sleeves, approvals, proposals, kill switch, ...
└── lib/
    ├── command-center/     The orchestrator, attack test, books, mock wiring, the end-to-end story
    ├── mandate/            Rules, validation, digest, policy builder, policy diff
    ├── strategy/           Trend and hold strategies, the Trader
    ├── runner/             The stake banker, events, state store
    ├── governance/         Proposals and council votes (mock)
    ├── dao/                Sputnik DAO client, governance, MPC owner signer, funder, live adapters
    ├── agent-api/          The Agent API interface, a policy-enforcing mock and the live client
    ├── persistence/        Save and restore the state (memory or atomic JSON file)
    ├── audit/              Append-only log tagged with the mandate digest
    ├── risk/               Fail-closed pricing, trigger, idempotency keys
    └── api/                Request validation and error mapping
scripts/simulate.mts        The headless end-to-end run
docs/                       Project documentation (see below)
```

Still to build: the frontend, wallet-based identity, and a first call to each live service. Persistence is built (`src/lib/persistence/`) and not yet wired into the dev API.

## Documentation

| File | What it covers |
|---|---|
| [`docs/what-we-are-building.md`](docs/what-we-are-building.md) | The product and how it works |
| [`docs/api-reference.md`](docs/api-reference.md) | Every route, its body and response, and how a screen uses them |
| [`docs/dao-live.md`](docs/dao-live.md) | Running on a real DAO: consent, MPC signing, votes per action, the time limit, what is verified |
| [`docs/live-agent-api.md`](docs/live-agent-api.md) | The live Agent API client and its first-run checklist |
| [`docs/backend-overview.md`](docs/backend-overview.md) | Layers, what is real and what is mocked, the guarantees tested |
| [`docs/plan.md`](docs/plan.md) | Scope, architecture, phases, tests and risks |
| [`docs/whats-done.md`](docs/whats-done.md) | What is finished and what is next |
| [`docs/protocols-integrated.md`](docs/protocols-integrated.md) | Each NEAR protocol, how we use it and its status |
| [`docs/decisions-and-open-questions.md`](docs/decisions-and-open-questions.md) | Decisions to settle and open questions |
| [`docs/submission-checklist.md`](docs/submission-checklist.md) | What the hackathon form needs |
| [`PLAN.md`](PLAN.md) | The plan as one table |

## Roadmap

| Phase | Dates | Goal |
|---|---|---|
| 0 Prepare | 28–31 Oct | Get an API key, count DAO votes per owner action, decide the build approach |
| 1 Foundation and mock | 1–3 Nov | Port the policy builder, mock and runner; overview and mandate pages |
| 2 Sleeves and banking | 4–7 Nov | Capped sleeves that bank their stake once |
| 3 Approvals, safety, live | 7–10 Nov | Approvals queue, kill switch, attack test, tiny live run |
| 4 Polish | 10–12 Nov | Error states, mobile, README |
| 5 Ship | 12–14 Nov | Final live run, demo, submission |

## Limitations

- Every owner action on a DAO is a vote, so setup is slow and the number of sleeves is limited.
- House Money's live client has never run against the real service, and its strategy has only seen scripted prices. This backend has no live client at all yet.
- Spending limits are enforced by the NEAR Intents Agent API, not by this app. The mock does not model confidential balances, owner approvals or USD budgets.
- Timelocks apply to swaps too, so a trade fills at the price when it releases.
- It promises no returns; it shows the controls working.
- Much of the reused code predates 1 Nov. What counts as new work needs checking with the organizers.

## Hackathon

NEAR Hackathon: development 1–14 Nov 2026, submission by 14 Nov 23:59 UTC. See [`docs/submission-checklist.md`](docs/submission-checklist.md).

## Team

To be added.

## License

To be decided.
