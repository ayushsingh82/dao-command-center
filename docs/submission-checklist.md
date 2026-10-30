# Submission checklist

Hackathon: development 1–14 Nov 2026. Submissions open 1 Nov 00:00 UTC and close **14 Nov 23:59 UTC**. Aim to submit on 13 Nov. Judging is 16–18 Nov. One submission per team.

## Requirements
- [ ] The repository is **public** (judges cannot open a private one)
- [ ] The project was built during the hackathon (check with the organizers what counts, given the reused prototypes)
- [ ] Any House Money code we reuse is published with the repository (its own repository is private)
- [ ] Demo post on X saying it was built at NEAR HACKATHON, with a video or screenshots
- [ ] Submit the repository link **and** the demo post link; both are required

## Form fields
| Field | Value |
|---|---|
| Project name | DAO Command Center |
| Team lead | To fill in |
| Email | To fill in |
| Team size | To fill in |
| Tracks | 12 Social Money, 1 Unstoppable DeFi, 6 AI Security & Defense, 4 Autonomous Business |
| NEAR wallet address | To fill in (where a prize would be sent) |
| Repository link | To fill in (no remote yet) |
| Demo post link | To fill in |
| What did you build? | 20–2,000 characters: the problem, what was built, and how NEAR fits |

## Draft of "What did you build?"
DAOs hold large treasuries but manage them by hand, and handing money to an AI agent is risky. DAO Command Center is one screen where a DAO signs its treasury rules once, runs strategy agents inside capped sleeves, banks each sleeve's starting amount back to the treasury once its gains cover it, holds large moves in an approvals queue for a vote, and can freeze everything with a kill switch. It runs on the NEAR Intents Agent API with Sputnik DAO as the owner, and reconciles public and confidential balances against the chain. *(Update this to match what was actually built.)*

## Before submitting
- [ ] A mandate has been set and approved on mainnet with small funds
- [ ] Two sleeves ran and one banked its stake
- [ ] A held move was released or vetoed from the approvals queue
- [ ] The kill switch worked and refused attempts were shown
- [ ] README states the limitations honestly
- [ ] Demo video and X post are up
- [ ] Release tag created, `main` frozen
