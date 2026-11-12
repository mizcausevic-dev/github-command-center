# Attention scoring model

The score answers one question: **which repository should the owner open first?** It is additive and capped at 100. Every point comes from a named signal with a reason string, so the dashboard can say why a repository is at the top instead of showing an opaque number. The weights live in one table (`WEIGHTS` in [`src/domain/attention.ts`](../src/domain/attention.ts)), are served at `GET /api/v1/meta/scoring`, and each is pinned by a test in [`test/attention.test.ts`](../test/attention.test.ts).

## Signals

| Signal | Group | Points | Fires when | Rationale |
|---|---|---|---|---|
| `ci_failing` | delivery | 30 | The latest completed run of any workflow on the default branch failed, timed out or failed to start | A red default branch blocks every other change and hides new regressions. Dependabot update jobs (`event: dynamic`) are excluded because they are not the repository's CI. |
| `release_drift` | delivery | 8 at 15+ commits, 12 at 50+ | Commits on the default branch since the latest non-draft, non-prerelease release | Unreleased work is value users cannot get yet. |
| `review_queue` | review | 6 per PR, cap 24 | Non-draft PRs by humans open 3+ days | A waiting contributor is the most expensive kind of idle. |
| `issue_backlog` | review | 5 per unanswered issue, 2 per issue quiet 30+ days, cap 25 | Issues with zero comments after 3 days; commented issues with no update for 30 days | First response matters more than resolution time for reporters. |
| `dependency_backlog` | maintenance | 2 per PR, cap 12, +6 if the oldest is 30+ days old | Open Dependabot or Renovate PRs, or PRs labeled `dependencies` | Many small updates are cheap individually; an old one is often a security fix nobody merged. |
| `dormant` | maintenance | 10 at 45+ idle days, 15 at 120+ | No default-branch commits for that long **and** there is open work | A finished project with nothing open is healthy, not dormant. |
| `owner_priority` | owner | P0 25 · P1 15 · P2 5 · P3 0 | Always | The owner's own judgment of importance. |
| `action_due` | owner | 12 per overdue action (cap 24), 4 per action due within 2 days (cap 8) | Open next actions with a due date | Commitments the owner made to themselves. |

## Bands

| Band | Score |
|---|---|
| critical | 60-100 |
| high | 35-59 |
| watch | 15-34 |
| healthy | 0-14 |
| archived | archived on GitHub; score forced to 0 |

## Known limits

- Weights are judgment, not fitted to outcome data. Change them in one place and the tests show which behaviors moved.
- Open-issue and PR lists are read up to 150 items each (3 pages of 50). Larger repositories report `listsTruncated: true` and their counts are lower bounds.
- CI status reads the latest 40 runs on the default branch. A workflow that has not run in that window does not count.
- Commit activity covers 26 weeks of default-branch commits, up to 300 commits.
- GitHub's events API only returns roughly the last 90 days, so the activity timeline can be empty for quiet repositories.
