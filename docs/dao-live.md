# Running on a real DAO

How the command center uses a Sputnik DAO as its council, how the DAO signs the Agent API's owner actions, what it costs in votes, and what has and has not been verified. The code is in `src/lib/dao/` and `src/lib/command-center/live.ts`.

## The three jobs a DAO does here

| Job | How | Code |
|---|---|---|
| **Consent** to the command center's own decisions (set the mandate, open a sleeve, approve a large trade, resume, …) | A proposal of kind `Vote`, which executes nothing. Its description holds one line of words, a marker line, and a line of JSON that commits to exactly one action and one DAO. The command center acts when the council approves it, and records that it did | `consent.ts`, `governance.ts` |
| **Sign** the Agent API's owner actions | A proposal that calls `v1.signer.sign` with the hash of the action. NEAR's MPC network signs it for the key derived from the DAO and the path `agent-owner`; that key's implicit account is the agents' owner | `signer.ts`, `delegate.ts`, `live.ts` |
| **Fund** a sleeve | A proposal that calls the token: register the agent's deposit address, then transfer | `funder.ts` |

Members vote from their own wallets (Trezu). The backend holds no member's key and refuses to vote for anyone (`external_vote`), unless it is given a member's key on purpose (`voters`, for a test DAO or a DAO of one).

## Votes per action

Each "proposal" below is one Sputnik proposal that the council must pass. Counts come from the calls in `command-center/service.ts`.

| Action | Consent | Signatures (`v1.signer`) | Funding | Proposals in all |
|---|---|---|---|---|
| Set or change the mandate | 1 | 1 per sleeve whose policy changes (`policy_update`) | | 1 + stale sleeves |
| Open a sleeve | 1 | 2 (`agent_create`, `grant_issue`) | 1 | **4** |
| Approve or veto a large trade (`trade_request`) | 1 | | | 1 |
| Approve a policy hold | 1 | 1 (`approval_vote`) | | 2 |
| Veto a hold or a veto-window request | 1 | 1 (`approval_vote` or `execution_cancel`) | | 2 |
| Approve a veto-window request | 1 | | | 1 |
| Retry a vetoed exit | 1 | | | 1 |
| Seal a sleeve after it banks | 1 | 1 (`policy_update`) | | 2 |
| Resume after the kill switch | 1 | 2 per frozen sleeve (unfreeze, new grant) | | 1 + 2 per sleeve |
| **Kill switch** | none | 2 per sleeve (freeze, revoke grant), 1 more for each queued request | | 2 per sleeve |

Two of these deserve attention:

- **The kill switch is not instant on a real DAO.** On the mock it freezes at once. Live, freezing a policy and revoking a grant are owner actions, so each is a DAO signature. The command center writes the stop to its own state before it calls anything, and refuses new work, but the money is only safe from the agent once the signatures land. A DAO that wants a fast stop needs a guardian role that can pass `call` proposals with a threshold of one. That guardian could then sign *any* owner action, not only a freeze, so it is a trust decision, not a setting.
- **Signatures are sequential.** Each one waits for a vote. Opening a sleeve is four proposals in a row; a kill switch over five sleeves is ten.

## The time limit

The Agent API gives each signature request about five minutes (observed on mainnet by the treasury prototype; not in the documentation). A Sputnik proposal stays votable for days, but a signature that arrives after the request expired is useless. So:

- the signer waits at most five minutes (and never past the request's own `expires_at`), then fails with `owner_signature_expired` (HTTP 504), and the action can be asked for again;
- the council has to be ready when an action starts. In practice this means a council that votes within minutes, or a one-vote threshold with `ONE_CLICK=yes`, where the proposer files and approves in one transaction;
- the proposal for an expired request stays on the DAO. It is harmless (the signature would not be accepted) and can be voted down.

A retry does not file a second proposal: if one is already open for the same hash, the signer waits on that one.

## Setting it up

1. **A DAO** whose council includes the proposer account. The proposer needs permission to add `vote` and `call` proposals; with `ONE_CLICK=yes` it also needs to approve them.
2. **The owner account must exist.** The DAO's owner account is the implicit account of its MPC key. A delegate action (`agent_create`) needs its access key on chain, so fund the account once, with a `Transfer` proposal from the DAO. The signer refuses to start an `agent_create` until it exists (`owner_account_unfunded`).
3. **Settings** (see below), including `CONFIRM_REAL_FUNDS=yes`.
4. **Start** with `COMMAND_CENTER_MODE=live`.

| Variable | |
|---|---|
| `CONFIRM_REAL_FUNDS` | Must be exactly `yes`. The Agent API has no test network |
| `NEAR_RPC_URL`, `NEAR_NETWORK_ID` | JSON-RPC endpoint; network id defaults to `mainnet` |
| `DAO_ACCOUNT_ID` | The Sputnik DAO |
| `PROPOSER_ACCOUNT_ID`, `PROPOSER_PRIVATE_KEY` | A DAO member that files proposals and pays their bond. The key is held in memory only |
| `NEAR_INTENTS_AGENT_API_KEY` | An `naa_…` key. `AGENT_API_BASE_URL` is optional |
| `STABLE_TOKEN_ID` | The DAO's stable token; its balance starts the treasury |
| `MPC_SIGNER_ID` | Default `v1.signer` |
| `FASTNEAR_API_KEY` | Optional; used to find signatures and, on a FastNear RPC, to read |
| `COMMAND_CENTER_SCOPE` | Default `main`. Tells apart command centers that share a DAO |
| `ONE_CLICK` | `yes` to file and approve in one transaction |
| `STATE_FILE`, `LEDGER_FILE` | Where state and the record of run proposals are kept (`.data/…`, owner-only) |

Every problem is reported at once, and no value is ever echoed.

## Safety properties

- A consent is read from the chain, never from a request. It must be a `Vote` proposal (it executes nothing), for this DAO and this scope, with a digest that matches its action, and approved by the DAO's own voting.
- Anyone the DAO's policy lets file may file a consent (Sputnik's default policy lets anyone). It does nothing until the council approves it.
- An approved consent is run once: a ledger records what the command center did with each, kept across restarts. Without the ledger a restart would run every approved proposal again, so use the file ledger.
- An approval older than 30 days, or a vote that ran out its voting period, is not acted on.
- A signature counts only if it verifies against the owner key *and* the hash the signer prepared, and was made after the request was prepared. A signature over any other hash, by the same key, is ignored.
- Reads that decide what to do with money use the final block. Reading back a write uses the newest block, because the final block trails by a few seconds.

## What has been verified

| Check | Against |
|---|---|
| The Sputnik client, governance, signer, delegate builder and funder, in 61 unit tests | An in-memory DAO that follows `sputnikdao2` |
| The same code in 8 sandbox tests | **The real Sputnik DAO v2 contract** (the build that ships with Trezu) in a local NEAR sandbox, with the real near-kit sender and the RPC reader |
| A NEP-413 owner intent signed through a real proposal, finding the signature in the transaction that passed it, verified against the owner key | Real DAO; the MPC network is a stand-in contract that returns signatures the test registered |
| A NEP-366 delegate action signed the same way, then relayed: **the chain accepted it, and refused a copy with one byte of the signature changed** | Real DAO and real chain; stand-in MPC |
| A funding proposal that registers an address and transfers | Real DAO; stand-in token |
| Rejection, a stale proposal id rolling back, and a member the DAO does not let vote | Real DAO |

## What has not

- **NEAR's real MPC signer (`v1.signer`)** has never been called from here. The sandbox cannot run it, so the sandbox tests use a stand-in that returns the same JSON shape. The treasury prototype does this on mainnet; the shape here is taken from it.
- **FastNear's transactions API** finds the signature on a live DAO. It is tested with a fake HTTP answer modelled on the prototype's, and in the sandbox by following transaction hashes. It has not been called.
- **The live Agent API** has never been called. Nothing in this project has spent a real token.
- **The kill switch and the five-minute window** are as described above from reading the code and the prototype's log, not from a live run.
- **Token weight and bounty roles.** Thresholds are worked out for group roles. A DAO whose council is token-weighted needs more.
