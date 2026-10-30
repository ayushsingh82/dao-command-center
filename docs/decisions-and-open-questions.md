# Decisions and open questions

## Decisions

| ID | Decision | Default | Status | Resolve by |
|---|---|---|---|---|
| D1 | Build on the Treasury gateway's owner API, or directly on the Agent API | Directly on the Agent API with House Money's client, plus read-only data from Treasury | Open | Phase 0, with the Treasury owner |
| D2 | What a sleeve is | A separate Agent API agent with its own policy and budget | Open | Phase 0, after counting the votes |
| D3 | Where state lives | A small hosted database for sleeves, runs and events | Open | 1 Nov |
| D4 | How the DAO approves | Sputnik proposals signed through MPC, shown in the approvals queue | Open | Phase 0 |
| D5 | Where the runner lives | A server process or scheduled function, not the browser | Open | 1 Nov |
| D6 | Mock first | Port House Money's policy-enforcing mock and develop against it | Decided | n/a |
| D7 | Next.js specifics | Read the guide named in `AGENTS.md` before writing code | Decided | 1 Nov |

## Open questions

| Question | Why it matters | Who | By |
|---|---|---|---|
| How many DAO votes does one sleeve need? | Decides how many sleeves a demo can have | To assign | End of Phase 0 |
| Can the Agent API's owner-approval holds drive the approvals queue? | The queue depends on it | To assign | End of Phase 0 |
| Does House Money's live client work against the real service? | It has never run | To assign | Phase 3 |
| What counts as new work, given the reused prototypes? | Eligibility | Organizers | Before 1 Nov |
| Can House Money's code be published, given its repository is private? | Judges need a public repository | Team | Before 1 Nov |
| Any limit on using real funds in the demo? | Safety | Organizers | Before 1 Nov |

## Decided so far
- Build a mandate, sleeves, an approvals queue and a kill switch.
- Tracks: 12, 1, 6 and 4.
- Develop against the mock first; run live only with small funds on a dedicated account.
- Nothing may be built before 1 Nov except research and design.
