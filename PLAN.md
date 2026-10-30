# DAO Command Center: plan at a glance

Tracks: **12 Social Money, 1 Unstoppable DeFi, 6 AI Security & Defense, 4 Autonomous Business**

Full detail: `docs/plan.md`. Product description: `docs/what-we-are-building.md`. Progress: `docs/whats-done.md`.

| Phase | Goal | Main tasks | Done when |
|---|---|---|---|
| **0 Prepare** | Learn and de-risk. | Get an Agent API key and matching base URL; run read-only checks; count the DAO votes needed to create an agent, issue a grant and update a policy; decide whether to build on the Treasury gateway or the Agent API directly; prepare a low-value owner account and safe address; confirm Node 24; send organizer questions; create the public repo | Key works with no funds moved; vote counts written down; repo exists |
| **1 Foundation and mock** | A working app on the mock | Read the Next.js guide in `AGENTS.md`; port the policy builder, risk checks, mock Agent API and runner from House Money; overview page; mandate page with the signed-policy preview and diff | Ported tests pass; mandate page shows what changes |
| **2 Sleeves and banking** | Strategies in capped sleeves | Model sleeves (budget, stake, trigger); bank-the-stake with a fixed idempotency key; cash-first, reserve and latched trigger; sleeve page | Two sleeves run; the stake is banked once, even after a crash and retry |
| **3 Approvals, safety, live** | Controls and a real run | Approvals queue with veto window; kill switch (freeze, revoke, show refusals); attack test on screen; live adapter with tiny amounts; reconcile against the chain | Every spend after the kill switch is refused; balances match the chain |
| **4 Polish** | Easy to use | Error, empty and loading states; mobile and accessibility; README with mock mode and limitations | A stranger can run the mock |
| **5 Ship** | Submit | Final recorded live run; demo video and X post; submission form; freeze and tag | Submitted before the deadline |

## Decisions to settle early
| ID | Question | Default |
|---|---|---|
| D1 | Build on the Treasury gateway's owner API or directly on the Agent API | Directly on the Agent API with House Money's client, plus read-only data from Treasury |
| D2 | What a sleeve is | A separate Agent API agent with its own policy and budget |
| D4 | How the DAO approves | Sputnik proposals signed through MPC, shown in the approvals queue |
| D5 | Where the runner lives | A server process or scheduled function, not the browser |

## Biggest risks
- Every owner action on a DAO is a vote, so the number of sleeves is limited.
- House Money's live client has never run against the real service.
- The mock does not model confidential balances, owner approvals or USD budgets.
- Native-key signing bypasses policy checks; keep it off.
- House Money's repo is private and its code predates the hackathon.
