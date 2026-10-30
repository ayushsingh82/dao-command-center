# The live Agent API client

`src/lib/agent-api/live.ts` implements the same `AgentClient` interface as the mock, against the real NEAR Intents Agent API (SDK `@near-intents-agent-api/sdk` 0.7.2). **It has never been run against the service.** It is tested through the real SDK with a fake network (`live.test.ts`, 26 tests): the SDK builds the real requests, the test answers them.

## What it spends

The Agent API has no test network. Anything below that moves money moves real money.

| Call | Moves money? | Owner signature? |
|---|---|---|
| `getTokens`, `getPolicy`, `getAgentBalances`, `listOperations`, `listScheduledExecutions`, `listHeldExecutions`, `getStatus` | No | No |
| `provisionAgent` | Yes, when it funds the agent | Yes (`agent_create`), plus the DAO's own transfer through the `Funder` |
| `updatePolicy`, `issueGrant`, `revokeGrant`, `cancelExecution`, `releaseHold`, `rejectHold` | No (they change rules or stop work) | Yes |
| `forGrant(token).swap / withdraw / transfer` | Yes | No, the grant acts inside the policy |

## Safety rails in the code

- `LiveAgentApi.connect()` refuses unless `realFunds: true` is passed, so spending is always a deliberate line.
- The key must start with `naa_`. Nothing is loaded or sent on a bad configuration.
- `provisionAgent` with money to send and no `Funder` fails before it creates anything.
- `agent_create` carries the idempotency key `agent_create:<name>`, so asking again after a crash returns the same agent.
- `UNCERTAIN` and `NEEDS_REVIEW` are reported as in flight, never failed: the API says never to resubmit either.
- A dropped connection becomes `transport_error`. The write may still have reached the API, so callers keep their idempotency key and read the status.
- The SDK is an ES module and this project is CommonJS, so it is loaded with a dynamic `import()` inside `connect()`.

## What the caller must supply

| Piece | What it is |
|---|---|
| `apiKey` | An `naa_…` key from the partner dashboard, in `.env` as `NEAR_INTENTS_AGENT_API_KEY`. Never in git, logs or a browser. |
| `owner` | The `OwnerWallet` that owns the agents: a NEAR account, an EVM address or a passkey. |
| `signer` | `OwnerSigner.sign(generated)`. For a DAO this is the vote: it must produce the signature through an approved DAO proposal (the signer contract), not one person's key. **Not built yet.** |
| `funder` | `Funder.fund(...)`. Sends the DAO's money to the agent's deposit address. **Not built yet.** |

## Mapping

| This app | The API |
|---|---|
| `HELD` | `PENDING_APPROVAL`; cleared by an `approval_vote` intent (`approve` or `reject`) using the approval id on the operation |
| `QUEUED`, `SUCCESS` | the same |
| `FAILED` | `FAILED`, `REFUNDED` |
| `PROCESSING` | `PROCESSING`, `UNCERTAIN`, `NEEDS_REVIEW`, `PENDING_SIGNATURE`, `PENDING_DEPOSIT` |
| agent id | assigned by the API on `agent_create`; the name we pass is only a label |
| grant balances | `available_raw` (free to spend); the owner's read uses `balance_raw` (what is held) |
| operation history | `getHistory`, all pages, oldest first, executions only (deposits are funding, not agent actions) |

## What to check on the first real run

1. `npm run live:check`: read-only. Confirms the key works, the service is up, and which of the mandate's assets exist (the example mandate uses simulation ids; set real ones).
2. Create one agent with a tiny stake, no funds beyond that, and a dedicated owner account.
3. Compare the real responses with these assumptions, which the fake network cannot prove:
   - the shape of `details.request`, `details.amount_out` and `details.approval_id` on swaps and withdrawals
   - that `listOperations` shows held requests as `PENDING_APPROVAL`
   - what a quote's amount field is called (the client reads `amountOut`, `amount_out` or `destination_amount`)
   - how many DAO votes one `agent_create`, `grant_issue` and `policy_update` each need
   - whether withdrawal fees make the books show a small unexplained difference (the books treat any difference as a flag)
4. Run the attack test against the live sleeve before trusting it.

## Not built

- The DAO signer and the funder (above).
- Reading on-chain transfers (FastNear) to reconcile beyond the API's own history.
- Paging for scheduled executions (the first page is read).
