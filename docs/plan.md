# DAO Command Center: plan

How we build it. The product is described in `what-we-are-building.md`. This plan covers scope, architecture, the work in phases, tests, risks and the submission.

## 0. Ground rules

- **Rules check:** the form says to build during the hackathon. This project started from generated `create-next-app` boilerplate. House Money and the Treasury prototype predate the hackathon, so ask the organizers what counts as new work and plan the mandate screen, sleeves, approvals queue and kill switch as the new build.
- **Public repo:** House Money's repo is private. The command center needs a public repo, and any House Money code we reuse has to be published with it.
- **Secrets:** API keys and private keys never go in the repo. Use `.env` (ignored) and a local secrets folder (ignored).
- **Money:** the Agent API has no test network. Use a dedicated low-value account and small amounts.
- **Node:** the real SDK needs Node 24 or later.

## 1. Scope

### Must have (the submission)
- Mandate screen: set rules, show the signed policy and the diff, vote.
- At least two strategy sleeves with caps, one with the bank-the-stake rule working.
- Approvals queue for held moves, with a veto window.
- Kill switch that freezes the agent and shows refused attempts.
- Balances (public and confidential) reconciled against the chain.
- One live run on mainnet with small funds.

### Should have
- The "try to break it" attack test on screen.
- An audit trail that shows the mandate hash behind each action.
- A mock mode so anyone can try the app without funds.

### Could have
- A strategy arena that ranks strategies in paper-trading.
- Rules in plain English that compile to a policy.
- A monthly report generated from reconciled numbers.

### Out of scope
- Return claims, custody, and replacing the DAO's governance.

## 2. Architecture

```
 Browser (Next.js)
   mandate / sleeves / approvals / balances / kill switch
        |
        v
 Next.js server routes  ---->  Store (sleeves, runs, events)
        |
        v
 Adapters
   AgentApi  (mock | live)   -> NEAR Intents Agent API
   Chain     (reads)         -> FastNear transfers, NEAR RPC
   Dao       (reads, votes)  -> Sputnik DAO / Trezu
   Signer    (owner intents) -> NEP-413 / NEP-366, DAO via MPC proposals
        |
        v
 Runner (strategy loop)  ->  price check -> decide -> act inside policy
```

### Key decisions

| ID | Decision | Default | How to resolve |
|---|---|---|---|
| D1 | Build on the Treasury gateway's owner API, or directly on the Agent API with House Money's client | Directly on the Agent API with the House Money client, plus read-only data from Treasury | Spike S3 |
| D2 | What a sleeve is | A separate Agent API agent with its own policy and budget | Spike S2: count votes needed per sleeve |
| D3 | Where state lives | A small hosted database for sleeves, runs and events | Pick the simplest option |
| D4 | How the DAO approves | Through Sputnik proposals signed by MPC, shown in the approvals queue | Spike S2 |
| D5 | Runner location | A server process or scheduled function, not the browser | Decide first |
| D6 | Mock first | Port House Money's policy-enforcing mock and develop against it | Phase 1 |
| D7 | Next.js specifics | Read the guide named in the project's `AGENTS.md` in `node_modules/next/dist/docs/` before writing code | First task |

## 3. Folder layout (inside `dao-command-center/`)

```
dao-command-center/
  src/
    app/                       Next.js pages and server routes
      page.tsx                 Overview: balances, sleeves, alerts
      mandate/                 Set rules, diff, vote
      sleeves/                 Sleeves and the bank-the-stake status
      approvals/               Held moves and the veto window
      safety/                  Attack test and kill switch
      api/                     Server routes
    lib/
      policy/                  Policy builder and Agent API types
      risk/                    Fail-closed pricing, trigger, idempotency
      agent-api/               Client interfaces, mock, live client, signer
      strategy/                Trend strategy and trader
      runner/                  Strategy loop, state, event log
      chain/                   Balance and transfer reads, reconciliation
      dao/                     Sputnik reads, proposals, MPC signing
  scripts/                     Simulation, live check, e2e
  .env.example                 Variable names only, never values
```

## 4. Phases

### Phase 0: prepare
| # | Task | Done when |
|---|---|---|
| S1 | Get an Agent API key from the partner dashboard and confirm the matching base URL; run `live:check`-style read-only checks | Key works; no funds moved |
| S2 | Count the DAO votes needed to create an agent, issue a grant and update a policy | A short note with numbers |
| S3 | Decide D1 with James after reading the Treasury owner API | Decision written |
| S4 | Prepare a dedicated low-value owner account and a safe address, outside the repo | Accounts funded with a little NEAR for gas |
| S5 | Confirm Node 24 and the toolchain on every machine | `node --version` is 24 or later |
| S6 | List organizer questions (what counts as new work, anything on fund use) and send them | Answers recorded |
| S7 | Create the public repo and turn this plan into issues | Repo exists; phases are issues |

### Phase 1: foundation and mock
| # | Task | Done when |
|---|---|---|
| 1.1 | Read the Next.js guide named in `AGENTS.md` | Notes on anything that differs |
| 1.2 | Port the policy builder, risk checks, mock Agent API and runner | Their tests pass |
| 1.3 | Overview page with balances from the mock | Renders with fake data |
| 1.4 | Mandate page: form, signed-policy preview, diff | Shows what changes against the policy in force |

### Phase 2: sleeves and banking
| # | Task | Done when |
|---|---|---|
| 2.1 | Model sleeves: budget, stake, trigger, status | Two sleeves on the mock |
| 2.2 | Bank-the-stake with the fixed idempotency key | Bank happens once under crash and retry tests |
| 2.3 | Cash-first, reserve and latched-trigger behavior from House Money | Matches House Money's tests |
| 2.4 | Sleeve page with equity, stake and banked state | Updates as the runner ticks |

### Phase 3: approvals, safety and live
| # | Task | Done when |
|---|---|---|
| 3.1 | Approvals queue with the veto window | Held moves show and can be vetoed |
| 3.2 | Kill switch: freeze, revoke grants, show refusals | Every spend after the switch is refused |
| 3.3 | Attack test on screen (overspend, new destination, revoked grant, rate limit) | All refusals shown |
| 3.4 | Live adapter on tiny amounts; reconcile against the chain | Balances match on screen |

### Phase 4: polish
| # | Task | Done when |
|---|---|---|
| 4.1 | Error states, empty states, loading states | No dead ends |
| 4.2 | Accessibility and mobile pass | Core screens work on a phone |
| 4.3 | README with setup, mock mode, the live checklist and limitations | A stranger can run the mock |

### Phase 5: ship
| # | Task | Done when |
|---|---|---|
| 5.1 | Final live run on mainnet, recorded | A clean run |
| 5.2 | Demo video and screenshots; post on X saying it was built at NEAR HACKATHON | Post link saved |
| 5.3 | Submission form (see section 8) | Submitted before the deadline, with time to spare |
| 5.4 | Freeze `main`; tag the release | Tag exists |

## 5. Tests

| Layer | What | How |
|---|---|---|
| Unit | Policy builder, pricing, trigger, idempotency key, strategy, trader | Test runner in the Next.js project |
| Mock enforcement | Every refusal in the attack test | A refusal matrix that must always pass |
| Simulation | Whole story headless: equity climbs, a sleeve banks, a red day burns only gains | A script that exits non-zero on any failure |
| Failure injection | Crash between withdraw and saving the flag, retried idempotent request | Scripted |
| End to end | Browser walk through every page and button | Playwright |
| Live read-only | Network status, token catalog, pricing on live data | Script that moves no funds |

Key properties to assert:
- The stake is withdrawn at most once.
- A missing or stale price halts the tick and nothing is sent.
- A frozen agent refuses every spend.
- After banking, a sleeve can only lose gains.

## 6. Risks and open questions

| Risk or question | Why it matters | Resolve by |
|---|---|---|
| Votes needed per sleeve | Decides how many sleeves a demo can have | S2 |
| The live client has never run | First real calls may differ from the mock | Phase 3 |
| Mock does not model confidential balances, owner approvals or USD budgets | The approvals queue depends on them | Phase 3 spike |
| Timelock delays on swaps | Trades fill at release price | Show it in the UI; size slippage to the delay |
| 10-minute cooldown between ordinary policy edits | Slows mandate changes | Account for it in the UI |
| Native-key signing bypasses policy | Would defeat the guard | Keep it off; add a check |
| Code that predates the hackathon | Eligibility | S6 |
| House Money repo is private | Judges cannot open it | Publish what we reuse |

## 7. Security checklist
- No keys in the repo, the browser or logs; keep `.env` and secrets ignored.
- The web app reads no private environment variables in the browser.
- Never put the owner key, API key or any spend-confirmation switch on a deployed server.
- Keep the smallest balance in any account used for a live run.
- Say plainly that limits are enforced by the Agent API, not by our code.

## 8. Submission checklist
Fields from the hackathon form:
- Project name, team lead, email, team size
- Tracks: **12 Social Money, 1 Unstoppable DeFi, 6 AI Security & Defense, 4 Autonomous Business**
- NEAR wallet address
- Public repository link
- Demo post link (the X post)
- "What did you build?" (20–2,000 characters): the problem, what was built, and how NEAR fits

## 9. Roles
To assign. Suggested split: one person on the Agent API, runner and sleeves; one on the Next.js screens; one on DAO integration, approvals and the live run.

## 10. Definition of done
- A mandate is set and approved on mainnet with small funds.
- Two sleeves run and one banks its stake.
- A held move is released or vetoed from the approvals queue.
- The kill switch works and refused attempts are shown.
- The tests in section 5 pass, the repo is public, the demo post is up and the form is submitted.
