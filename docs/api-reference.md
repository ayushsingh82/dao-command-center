# API reference

The backend is a set of JSON routes under `/api`. It runs on a mock (no network, no funds), so a frontend can be built against it now. The routes are the same ones a live deployment will keep.

**No authentication yet.** `by` and `member` are names the caller declares. Do not expose this API publicly: anyone who can reach it can act as any council member. In a live deployment a member is identified by a NEAR wallet signature and a Sputnik proposal.

## Conventions

- Requests with a body are `POST` with `content-type: application/json`.
- Money is a **decimal string** in USD (`"1000"`, `"0.5"`). Token amounts are **atomic-unit strings**. There are no numbers for money, so nothing loses precision.
- Everything is computed per request. Nothing is cached.
- A change the DAO must vote on returns **202** with the `proposal`. When the council auto-approves (the default in the mock) the proposal is already `executed` in that response.
- Errors always look like `{ "error": { "code": "...", "message": "...", ... } }`.

### Errors

| Status | Codes | Meaning |
|---|---|---|
| 400 | `bad_request`, `invalid_mandate` | The body is missing, not JSON, or fails validation. `invalid_mandate` carries a `problems` list. |
| 403 | `not_a_member`, `not_allowed` | The voter is not on the council, or the DAO does not let this account file this kind of proposal |
| 404 | `unknown_sleeve`, `unknown_approval`, `unknown_proposal` | No such thing |
| 409 | `not_pending`, `already_voted`, `killed`, `not_killed`, `external_vote` | The thing is not in a state that allows this. `external_vote`: on a real DAO each member votes from their own wallet (Trezu); the message says which proposal to approve |
| 404 | `mock_only` | A simulation control was asked for on a live server |
| 502 | `chain_unavailable`, `dao_error` | The chain could not be read or written, so nothing is known about the proposal |
| 503 | `not_configured` | Live mode is on and a setting is missing; the message names the settings, never their values |
| 504 | `agent_api_error` with `agentApiCode: owner_signature_expired` | The council did not sign within the Agent API's window; ask again |
| 422 | `stake_exceeds_sleeve_cap`, `risk_bucket_exceeded`, `runway_floor_breached`, `asset_not_allowed`, `mandate_not_set` | The request would break the mandate |
| 502 | `agent_api_error` | The Agent API refused something; `agentApiCode` has its code |
| 500 | `internal` | A bug |

## Reading

### `GET /api/state`
Everything a screen needs in one read.

```jsonc
{
  "mode": "mock",
  "now": "2026-11-01T00:00:12.000Z",
  "mandate": { /* see Mandate */ },
  "mandateDigest": "049f4083…",           // sha256 of the canonical mandate
  "killed": null,                          // or { "at", "by", "reason" }
  "treasury": {
    "stableUsd": "19700",
    "runwayFloorUsd": "5000",
    "availableToAllocateUsd": "1700",      // what could still be opened as sleeves without breaking the mandate
    "riskBucket": { "capUsd": "3000", "atRiskUsd": "300" }
  },
  "sleeves": [ /* SleeveView */ ],
  "approvals": [ /* ApprovalView, pending first */ ],
  "proposals": [ /* Proposal */ ],
  "council": { "members": ["alice.near", "bob.near", "carol.near"], "threshold": 2, "autoApprove": true },
  "prices": { "nep141:wnear-sim": 3.1, "nep141:usdc-sim": 1 },
  "events": [ /* the last 100 AuditEntry */ ]
}
```

**SleeveView**

| Field | Meaning |
|---|---|
| `id`, `name`, `agentId` | Identity |
| `strategy` | `{ "kind": "trend", "alpha"?, "band"? }` or `{ "kind": "hold" }` |
| `riskAsset` | The one risk asset it may hold |
| `status` | `active`, `banked` (stake returned; trading only gains), `bank_failed` (exit vetoed or failed; paused), `frozen` |
| `stakeUsd`, `equityUsd`, `pnlUsd` | `equityUsd` and `pnlUsd` are `null` when a balance cannot be priced right now |
| `progressToTrigger` | Equity as a share of the level at which the stake banks; `1` means at the trigger |
| `exit` | `none`, `triggered` (waiting for cash), `queued`, `settled`, `failed` |
| `balances` | `{ assetId: atomic }`, read by the owner, so it works after grants are revoked |
| `hold` | The sleeve is on owner approval: every money action waits for the DAO |
| `sealed` | `withdraw` was removed from its policy: the stake cannot leave twice |
| `policyStale` | The policy in force differs from the mandate (waiting out the API's edit cooldown) |

**ApprovalView**: `id`, `kind`, `sleeveId`, `sleeveName`, `summary`, `valueUsd`, `createdAt`, `expiresAt?`, `status`, `decidedAt?`.

| `kind` | What it is | `approve` does | `veto` does |
|---|---|---|---|
| `trade_request` | A trade that adds risk and is over the mandate's threshold. Nothing was sent. | Sends it | Discards it; the sleeve decides again |
| `veto_window` | A request queued behind the policy's delay. It will run when `expiresAt` passes. | Lets it run (item closes) | Cancels it |
| `policy_hold` | A request held because the sleeve is on owner approval | Releases it (it then waits out the delay) | Rejects it |

`status` is `pending`, `approved`, `vetoed`, `expired`, `executed` or `dismissed`.

**Proposal**: `id`, `action` (`{ "type": "set_mandate" | "open_sleeve" | "seal_sleeve" | "decide_item" | "resume" | "retry_bank", ... }`), `summary`, `proposer`, `createdAt`, `status` (`pending`, `approved`, `rejected`, `executed`, `failed`), `votes` (`{ member: "approve" | "reject" }`), `members`, `threshold`, `executedAt?`, `error?`.

**AuditEntry**: `seq`, `at`, `kind`, `sleeveId?`, `mandateDigest`, `data`. Every entry carries the digest of the mandate in force.

### `GET /api/events?after=<seq>&limit=<n>`
The audit trail. `after` returns only newer entries (poll with the last `seq` you saw). `limit` keeps the last n. Returns `{ "events": [...] }`.

### `GET /api/mandate`
`{ "mandate": {...} | null, "digest": "..." }`.

### `GET /api/sleeves`, `GET /api/approvals?status=pending`, `GET /api/proposals`
Lists. `/api/proposals` also returns the `council`.

### `GET /api/books`
Reconciliation: our record against what the API reports.

```jsonc
{ "at": "...", "treasuryStableUsd": "19700", "reconciled": true,
  "sleeves": [{ "id": "s1", "name": "...", "fundedUsd": "1000", "withdrawnToSafeUsd": "1000",
                "equityUsd": "1027.04", "pnlUsd": "1027.04",
                "reportedBalances": {}, "expectedBalances": {},
                "unexplained": {},              // assets where reported != expected, by how much
                "unrecordedOperations": [] }] }  // operations the API has that we never recorded
```

## Changing things

### `POST /api/mandate` → 202 `{ proposal }`
Body `{ "mandate": Mandate, "by": "alice.near" }`. Takes effect when the DAO's vote passes. Existing sleeves' policies are updated to match; a sleeve the API will not edit yet stays `policyStale` and catches up on a later tick.

### `POST /api/mandate/preview` → `{ sleeves: [{ sleeveId, changes: [{ path, before, after }] }] }`
What a mandate would change in each sleeve's policy. Changes nothing. Show this on the page the DAO votes on.

**Mandate**

```jsonc
{ "version": 1, "daoAccount": "example.sputnik-dao.near",
  "safe": { "chain": "base", "address": "0x…" },          // where banked stakes return
  "stableAsset": "nep141:usdc-sim", "riskAssets": ["nep141:wnear-sim"],
  "runwayFloorUsd": "5000",        // never goes into sleeves
  "maxRiskBucketUsd": "3000",      // most at risk in sleeves at once
  "maxSleeveStakeUsd": "1500",
  "bankMultipleBps": 20000,        // 20000 = bank the stake at 2x
  "sealAfterBank": true,
  "timelockMs": 10000,             // the veto window on every money action
  "maxActionsPerHour": 60,
  "approvalThresholdUsd": "400",   // risk-adding trades above this wait for the DAO
  "budgets": { "dailyUsd": null, "weeklyUsd": null, "monthlyUsd": null },
  "slippageBps": 3000, "holdAllSleeves": false }
```

### `POST /api/sleeves` → 202 `{ proposal }`
Body `{ "name", "stakeUsd", "strategy", "riskAsset", "hold"?, "by" }`. The mandate is checked now (422 if it would break a rule) and again when the vote passes.

### `POST /api/sleeves/{id}/retry-bank` → 202 `{ proposal }`
Body `{ "by" }`. Another attempt at a stake exit the DAO vetoed or the API failed. Only for a `bank_failed` sleeve.

### `POST /api/approvals/{id}` → `{ item, proposal }`
Body `{ "decision": "approve" | "veto", "member": "alice.near" }`. The `id` contains colons: URL-encode it. This files a proposal for the decision and casts the member's vote; the item changes once enough members agree. Calling it again as another member adds their vote.

### `POST /api/proposals/{id}/vote` → `{ proposal }`
Body `{ "member", "vote": "approve" | "reject" }`. Use this for proposals that are not queue decisions (mandate, sleeves, resume, seal).

### `POST /api/kill-switch` → `{ at, frozen, grantsRevoked, cancelled, approvalsClosed }`
Body `{ "by", "reason"? }`. Acts at once, with no vote. Freezes every sleeve, revokes every grant, cancels everything waiting, closes the queue. Safe to press twice.

### `POST /api/resume` → 202 `{ proposal }`
Body `{ "by" }`. A vote to lift the kill switch. Sleeves return on new grants. If the API's edit cooldown is running, the sleeves stay frozen until it ends and a later tick lifts it.

### `POST /api/tick` → `{ at, skipped?, sleeves, newApprovals, executedProposals }`
One pass over every sleeve. Call it on a timer. `skipped` is `kill_switch` or `no_mandate` when it did nothing.

### `POST /api/attack-test` → `{ reports: [{ sleeveId, sleeveStatus, checks, passed }] }`
Body `{ "sleeveId"? }` (empty body means every sleeve). Tries everything a compromised strategy might: each probe must be refused. `checks` is `[{ id, label, expected, got, pass }]`. A frozen sleeve is tested with its old grant and with a brand-new one. Mock only: live probes touch real accounts.

## Mock controls (do not exist on a live deployment)

| Route | Body | Does |
|---|---|---|
| `POST /api/sim/advance` | `{ ms }` | Moves time forward; releases anything whose delay is up. Returns `{ now }` |
| `POST /api/sim/price` | `{ assetId, price }` | Sets a price |
| `POST /api/sim/stale` | `{ assetId, stale }` | Simulates a price-feed outage |
| `POST /api/sim/governance` | `{ autoApprove }` | `true`: every proposal passes at once. `false`: members must vote. Returns `{ council }` |
| `POST /api/sim/play` | `{ assetId, prices: number[], stepMs? }` | Walks a price path, one price per step, ticking after each. Returns `{ ticks, snapshot }` |
| `POST /api/sim/reset` | `{ treasuryUsdc?, autoApprove?, mandate? }` (optional) | Starts over |

Simulated assets: `nep141:usdc-sim` (USDC, $1), `nep141:wnear-sim` (wNEAR, starts at $1), `nep141:weth-sim` (wETH, starts at $2,000).

## How a screen uses it

1. **Load:** `GET /api/state`. Poll it, or poll `GET /api/events?after=<seq>` and refetch state when something new arrives.
2. **Run:** call `POST /api/tick` on a timer (and `POST /api/sim/play` to demo a market).
3. **Set rules:** show `POST /api/mandate/preview`, then `POST /api/mandate`. Show the proposal and its votes.
4. **Open a sleeve:** `POST /api/sleeves`. A 422 tells you which mandate rule it breaks.
5. **Queue:** list `state.approvals` where `status === "pending"`. Approve or veto each with `POST /api/approvals/{id}`.
6. **Votes:** list `state.proposals` where `status === "pending"` and vote with `POST /api/proposals/{id}/vote`.
7. **Panic:** `POST /api/kill-switch`. Then `state.killed` is set, every sleeve is `frozen`, and ticks do nothing. Lift it with `POST /api/resume` and the votes.
8. **Prove it:** `POST /api/attack-test` and `GET /api/books`.

## Live mode

With `COMMAND_CENTER_MODE=live` every route above works on a real DAO (see `dao-live.md`) except the `/api/sim/*` routes, which answer 404 `mock_only`. A change that needs the council returns the filed `proposal` as `pending`; it runs when the council has approved it on chain and a later `POST /api/tick` (or any call that settles proposals) sees it. Opening a sleeve or resuming can take several proposals in a row, each of which must be approved within a few minutes of being asked for, so those calls can run for minutes.
