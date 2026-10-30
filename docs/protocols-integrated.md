# NEAR protocols: what we use and where it stands

**No live protocol has been called from this app yet.** The Agent API has a live client (built on the official SDK and tested on a fake network) and a mock; the DAO council exists only as a mock behind the interface a Sputnik client will fill. The earlier prototypes (the Treasury prototype and House Money) already integrate some of these; the "Earlier prototypes" column says what, so it is clear what we can reuse and what must be built again here.

## Status levels

| Level | Meaning |
|---|---|
| Not started | Not looked at in depth |
| Researched | Documentation read; nothing run |
| Mocked | Built and tested against a stand-in; nothing real called |
| Spiked | Called once with a test amount; result written down |
| Integrated | In the code with tests |
| Live | Used on mainnet |

## Protocols

| Protocol | What we use it for | Earlier prototypes | Status in this app | Next step |
|---|---|---|---|---|
| **NEAR Intents Agent API** | Signed policies, grants, swaps, withdrawals, shield and unshield, confidential balances, timelocks, schedules, owner approvals, USD budgets | Treasury prototype: live on mainnet. House Money: mock agent complete; live client built and guarded but never run against the real service. | Mocked; live client built, tested on a fake network, never run | Get a key, run `npm run live:check`, then one tiny real agent (see `live-agent-api.md`) |
| **Sputnik DAO** | The DAO that owns the agent and votes on owner actions | Treasury prototype reads the DAO policy and membership and files owner-action proposals | Mocked, and **sandboxed**: the client runs against the real Sputnik DAO v2 contract in a local NEAR sandbox | Votes per action are counted in `dao-live.md`. Run once against a DAO on a public network |
| **NEAR MPC signing (`v1.signer`)** | Lets a DAO sign owner intents through a proposal that calls `v1.signer` | Treasury prototype implements it for DAO owners | **Sandboxed with a stand-in signer**: NEP-413 and NEP-366 owner actions signed through a real proposal; a relayed delegate action was accepted on chain | Call the real `v1.signer` once |
| **Trezu** | DAO treasury front end; DAO membership | The Treasury prototype describes selecting a DAO through Trezu; not independently verified by us | Not started | Decide whether we integrate or only link |
| **FastNear** | Finds the DAO's signatures on chain; transfer reads for reconciliation | Treasury prototype's books use it | Mocked (signature finder against fake HTTP). Reconciliation reads not started | Call it once; reuse the reconciliation approach |
| **`@multiagency/sdk`** | A typed owner client for the Treasury gateway | Used by the Treasury frontend | Not started | Not installable as a package yet; see decision D1 |
| **OutLayer** | The custody layer behind the Agent API | Not called directly | Not started | None needed unless we use payment checks |

## What is known about the Agent API
- The owner signs a policy (allowed actions, assets, destinations, USD budgets, per-asset limits, hourly caps, a timelock of up to 30 days, an optional schedule, optional owner approval) and issues grants that let an agent act inside it.
- Owner intents are signed with NEP-413, NEP-366, EIP-712 or WebAuthn.
- There is no test network. House Money's notes say ordinary policy edits have a 10-minute cooldown, and a pure freeze bypasses it.
- Native-key signing bypasses most policy checks, so it must stay off.

## What we do not know yet
- How many DAO votes one agent, one grant and one policy update each need.
- Whether the Agent API's owner-approval holds can drive the approvals queue directly.
- Whether the live House Money client works against the real service.

## Sources
- NEAR Intents Agent API: `api.agentsonintents.com/llms.txt`
- OutLayer agent custody: `outlayer.fastnear.com/docs/agent-custody`
- Treasury prototype and House Money documentation (local repositories)

## Evidence log
| Date | What | Result |
|---|---|---|
| 28 Oct | Read the Agent API documentation and the earlier prototypes' notes | Notes in this file |
| 28 Oct | Wrote the live Agent API client on SDK 0.7.2 and tested it through the SDK on a fake network; aligned the mock's error codes and hold status with the SDK's documentation | 26 live-client tests. Never run against the service. |
| 28 Oct | Built the Sputnik client, consent governance, MPC owner signer, funder and live adapters; ran them against the real Sputnik DAO v2 contract in a local sandbox with a stand-in MPC signer | 61 unit tests and 8 sandbox tests pass. A DAO-signed delegate action was accepted on chain; a one-byte-changed copy was refused. The real `v1.signer` and FastNear were not called. |
| 28 Oct | Built the Agent API mock, the council mock, and ran the whole product against them | 140 tests, the simulation, and a real-server HTTP run pass. Nothing real was called. |
