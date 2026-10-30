# What is done

Stage: **the backend is built.** The command center runs on a mock Agent API and council; the Sputnik DAO client, the MPC owner signer and the funder have also run against the **real Sputnik DAO v2 contract** in a local NEAR sandbox. The frontend is not built. Nothing has called a live service (the Agent API, NEAR's MPC signer, FastNear) or spent a real token. Update this file as work finishes.

## Done

| Item | Evidence |
|---|---|
| Hackathon page read; tracks and submission fields noted | `submission-checklist.md` |
| NEAR products researched | `protocols-integrated.md` |
| Idea, tracks, plan and product description written | `what-we-are-building.md`, `plan.md`, `../PLAN.md` |
| Next.js app scaffolded (Next.js 16.4.3, TypeScript, Tailwind CSS 4, App Router, `src/`) | `src/app/` |
| **Mandate:** validated rules, canonical form and digest, policy builder, policy diff | `src/lib/mandate/` |
| **Agent API mock:** grants, freeze, allowlists, caps, hourly rate, rolling USD budgets, owner-approval holds, the delay queue, replay protection, policy-edit cooldown | `src/lib/agent-api/mock.ts` |
| **Sleeves:** capped, funded from the treasury, checked against the mandate (stake cap, risk bucket, runway floor, allowed assets) twice: at the proposal and again when the vote passes | `command-center/service.ts` |
| **Bank the stake:** exactly once, crash-safe, then sealed by a passed proposal | `runner/banker.ts` |
| **Trader:** trend and hold strategies; a swap that adds risk over the threshold waits for the DAO; risk-reducing trades never do | `strategy/trader.ts` |
| **Governance:** proposals, a council with a threshold, votes, auto-approve for demos | `src/lib/governance/` |
| **Approvals queue:** large-trade requests, owner-approval holds, the veto window; approve or veto by vote; expiry | `command-center/service.ts` |
| **Kill switch** (acts at once on the mock; on a real DAO each freeze and revocation is a DAO signature, see `dao-live.md`), **resume** (a vote, new grants only, waits out the API's edit cooldown), **retry** after a vetoed exit | `command-center/service.ts` |
| **Attack test:** every probe a compromised strategy might try, on live and frozen sleeves | `command-center/attack-test.ts` |
| **Books:** reconcile the API's balances against its operation history and our audit trail | `command-center/books.ts` |
| **Live Agent API client** behind `AgentClient` (SDK 0.7.2): owner intents, grants, swaps, withdrawals, history, queue, held requests, provisioning; refuses to be built without `realFunds: true`. Tested through the real SDK on a fake network; never run against the service | `src/lib/agent-api/live.ts`, `docs/live-agent-api.md` |
| **Sputnik DAO client and governance:** `Vote` proposals as the council's consent, read back from the chain, run once (ledger), thresholds from the DAO's policy | `src/lib/dao/sputnik.ts`, `governance.ts`, `consent.ts`, `ledger.ts` |
| **DAO owner signer:** the DAO signs the Agent API's owner actions through a proposal calling `v1.signer`; NEP-413 and NEP-366 (delegate actions) | `src/lib/dao/signer.ts`, `delegate.ts` |
| **DAO funder, live adapters (RPC reader, near-kit sender, FastNear finder) and the live command center factory** | `src/lib/dao/funder.ts`, `live.ts`, `src/lib/command-center/live.ts` |
| **Votes per owner action counted** from the code | `docs/dao-live.md` |
| **Strict base58 key decoder** (a test showed it accepted `"11"` as four zero bytes) | `src/lib/dao/keys.ts`, `keys.test.ts` |
| **Persistence:** the state is saved after every change (atomic file write, owner-only) and restored on restart; the kill switch is saved before it calls the API | `src/lib/persistence/` |
| **Audit trail** tagged with the mandate digest on every entry | `src/lib/audit/log.ts` |
| **21 JSON routes** with validation and error mapping; all dynamic | `src/app/api/` |
| **Headless simulation** of the whole product with real votes | `npm run simulate` |
| **API reference and backend overview** for the frontend | `api-reference.md`, `backend-overview.md` |
| Mock aligned with the SDK: the real refusal codes (`policy_asset_denied`, `spend_budget_exceeded`) and the owner-approval status | `agent-api/mock.ts` |
| A bug found in the ported House Money trader (it traded on a stale price for an asset it did not hold) and fixed, with a test | `strategy/trader.test.ts` |
| A production bug found by building: three GET routes would have been frozen at build time. Fixed. | `src/lib/api/http.ts` |

## Checks that pass

| Check | Result |
|---|---|
| `npm test` | 244 tests pass |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | succeeds; every `/api` route is dynamic |
| `npm run simulate` | all checks pass |
| `npm run test:sandbox` | 8 tests against the real Sputnik DAO contract in a local NEAR sandbox |
| Real server (`next start`) driven with curl | state persists between requests and is not cached; errors map to the right status codes; no grant in any response |

## Not done

- [ ] The frontend (the page is still the Next.js starter)
- [ ] Run the live Agent API client against the service (needs an API key and a funded dedicated account; the Agent API has no test network)
- [ ] Wallet-based identity (the API has no authentication)
- [ ] NEAR's real MPC signer, FastNear and the Agent API called once each (nothing here has touched a live service)
- [ ] A fast stop: a guardian role, or another way to freeze without waiting on a council
- [ ] A live run with small funds
- [ ] Decide who owns what; send the organizer questions; create the public repository

## Groundwork from before the hackathon (outside this project)

| Piece | State |
|---|---|
| Treasury prototype: signed policies, caps, confidential balances, reconciled books, run report | Live on mainnet; open pull requests #6 to #10 |
| House Money: policy, runner, trend strategy, trader, attack test, mock | Mock complete; the live client is built but has never run. The repository is private. Its policy, risk, strategy, trader and banker code was ported into this project. |
| DAO approval for machine credentials | Treasury pull request #8, open |
| Dashboard treasury page work | Pull requests #80 and #81, open |

None of this counts as hackathon-window work. Ask the organizers what counts.
