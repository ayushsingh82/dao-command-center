# DAO Command Center: what we are building

**One line:** a control room where a DAO sets its treasury rules once, lets AI agents run investment strategies inside them, and keeps the final say.

## 1. The problem

- DAOs hold large treasuries but manage them by hand, one vote at a time.
- Handing money to an AI agent is risky, so most DAOs never try strategies.
- If a strategy fails, the DAO's runway, the money that pays for its work, is at stake.
- Treasury state is scattered: public balances, confidential balances, pending proposals and agent activity live in different places.

## 2. What we are building

One screen with six parts:

- **Mandate.** The DAO signs its rules once: how much stays untouchable as runway, how much may go into a risk bucket, per-asset and USD caps, allowed assets, allowed destinations, a delay before money leaves, and a schedule.
- **Strategy sleeves.** Each strategy runs in its own capped slice of the risk bucket, so one bad strategy cannot touch the rest.
- **Bank the stake.** When a sleeve's gains cover what it started with, the starting amount returns to the treasury automatically, exactly once. After that the sleeve can only lose gains.
- **Approvals queue.** Large or unusual moves are held until the DAO votes, and the screen shows what is waiting and why.
- **Kill switch.** One action freezes the agent and revokes its access. Every later spend attempt is refused.
- **Reconciled balances and audit trail.** Public and confidential balances matched against the chain's records, with every action tied to the hash of the mandate it ran under.

## 3. How it works, step by step

1. **Set the mandate.** A council member fills in the rules. The tool shows the signed policy and what changes against the current one.
2. **Vote.** The DAO approves the mandate. For a DAO owner, each owner action is a proposal signed through NEAR's MPC network, so it is a vote.
3. **Open sleeves.** For each strategy, create a sleeve with its own budget and stake.
4. **Run.** On each tick the runner reads balances, prices them from the token catalog, asks the strategy for a decision and acts only inside the policy. A missing or stale price halts the tick.
5. **Bank.** When a sleeve's equity reaches the trigger (for example 2x its stake), the runner withdraws exactly the stake to the DAO's safe account, using a fixed idempotency key so it can never happen twice.
6. **Approve or veto.** Money that must wait shows in the approvals queue, with a veto window before it leaves.
7. **Stop.** At any time the kill switch freezes the agent.

## 4. What already exists and what it is built from

| Piece | Source | What we reuse |
|---|---|---|
| Signed policies, caps, confidential balances, reconciled books, run report | Treasury prototype (James) | Policy envelope, balances, reconciliation, evidence |
| Bank-the-stake logic, trend strategy, trader, policy builder, "try to break it" test | House Money (Ayush) | Runner, trigger, refusal matrix, mock agent |
| DAO approval for machine credentials | Treasury PR #8 | DAO-approved access |
| Budgets and billings ledger | multiagency.ai Dashboard | Optional integration |

## 5. Who uses it

- **DAO treasurers and council members** who need to run strategies without handing over the keys.
- **Strategy builders** who want a safe place for their agent to run inside rules the DAO has signed.

## 6. What it is not

- It does not promise returns. It shows the controls working.
- It does not replace the DAO's governance or its multisig.
- It is not a custodian: spending limits are enforced by the NEAR Intents Agent API, not by this app.

## 7. Tracks we are entering

- **12 Social Money:** shared DAO budgets on Sputnik DAO and Trezu, built for how communities use a treasury.
- **1 Unstoppable DeFi:** trading agents that settle across chains through NEAR Intents.
- **6 AI Security & Defense:** spending limits and a policy engine, so AI holds money without holding the keys.
- **4 Autonomous Business:** treasury management where humans set the constraints and agents do the work.

## 8. NEAR products used

| Product | What it does here |
|---|---|
| **NEAR Intents Agent API** | Policies, grants, swaps, withdrawals, confidential balances, timelocks and owner approvals |
| **Sputnik DAO and Trezu** | The DAO that owns the agent and votes on owner actions |
| **NEAR MPC signing** | Lets a DAO sign owner intents through a proposal |
| **FastNear** | Reads on-chain transfers for reconciliation |

## 9. Limitations to be honest about

- The Agent API is **mainnet only**, so every run uses real funds. Use a dedicated low-value account.
- Every owner action on a DAO is a vote, so setup has to stay light and few agents are practical.
- House Money's live client has never run against the real service, and its strategy has only seen scripted prices.
- The mock does not model confidential balances, owner approvals or USD budgets.
- Timelocks apply to swaps too: a trade fills at the price when it releases, not when it was requested.
- Native-key signing in the Agent API bypasses most policy checks, so it must stay off.
- Much of the code predates 1 Nov, so what counts as new work needs checking with the organizers.

## 10. What success looks like

- A DAO mandate set and approved on mainnet with small funds.
- At least two sleeves running, one of which banks its stake.
- A large move held in the approvals queue and released or vetoed.
- The kill switch working, with refused attempts shown.
- Balances reconciled against the chain on screen.

## 11. Open questions

- How many DAO votes does one sleeve need to create? Fewer agents per DAO may be the practical answer.
- Do we build the screen on the Treasury gateway's owner API, or directly on the Agent API with House Money's client?
