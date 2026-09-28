# Restore drill log

**Owner:** Spec 046 §3.11 (AC-6). Each drill follows [disaster-recovery.md](disaster-recovery.md)
into a **new Neon branch** and is recorded here.

**Required cadence:** the **first drill before production launch**, then **quarterly**, and after any
major infrastructure change (a Neon plan/region/project change, a Postgres major version upgrade, a
change of hosting). AC-6 is satisfied only by a recorded drill — not by this template.

## Status

**No drill has been executed yet.** The production Neon project (DEP-2) is not provisioned from this
repository; the first drill is an open pre-launch requirement.

## Log

| Date (UTC) | Operator | Target time restored | Duration (branch created → verified) | Row counts match (`users`, `bookings`, `payments`, `audit_logs`) | Latest migration matches | `/health/detailed` against the restore | Issues found / follow-ups |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — |

## Entry template

Copy for each drill:

```markdown
### Drill YYYY-MM-DD

- Operator:
- Neon project / source branch:
- Target time (UTC):
- Restore branch name:
- Started / verified (UTC):          → duration:
- Row counts (restore vs source at target time):
  - users:        /
  - bookings:     /
  - payments:     /
  - audit_logs:   /
- Latest applied migration vs drizzle/meta/_journal.json:
- GET /api/v1/health/detailed against the restore: database = , migrations =
- Issues found:
- Follow-ups (with owner):
```
