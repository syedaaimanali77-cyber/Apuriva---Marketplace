# Incident: \<one line, the failure and the surface — not the fix\>

**Date:** YYYY-MM-DD
**Duration:** \<first impact → mitigation, in minutes or hours; say "unknown, at least N" if the
start is genuinely not recoverable\>
**Severity:** SEV1 (production down or data lost) | SEV2 (production degraded) | SEV3
(non-production, or contained) — pick one, and say what it was scoped to
**Author:** \<name\>
**Reviewer:** \<name — someone who was not involved\>
**Status:** Draft | Reviewed

> Copy this file to `docs/incidents/YYYY-MM-DD-short-slug.md`. Keep every heading. Write "None" or
> "Not applicable" where a section is genuinely empty, so a reader can tell *considered and empty*
> from *forgotten* — the same rule as the spec template.
>
> **This report is blameless.** It names systems, changes, commits, and gaps. It does not name a
> person as a cause. "The migration dropped the column" is a finding; "X dropped the column" is
> not, and the difference is the difference between a report people write honestly and a report
> people write defensively. The Timeline may name roles or actors ("on-call", "the deploy job",
> "a reviewer") strictly where it is needed to explain sequence — who acted when, never who is at
> fault.

---

## Symptom

> What was actually observed, in the words of whoever saw it first — the alert text, the user's
> message, the log line, the screenshot. Before anyone had a theory.
>
> Not the diagnosis. "Connection pool exhausted" belongs in Root cause; "the Items page spun
> forever and then showed the generic error" belongs here. Writing the diagnosis here hides how
> long the symptom went unexplained, which is usually the interesting part.

## Impact

> Who was affected, how many of them, for how long, and what specifically they could not do.
> Quantified. Requests failed, records affected, environments, tenants, percentage of traffic.
>
> **"Some users may have been affected" is not an impact statement.** If the number is genuinely
> unknown, say so and say why the number is unknown — that is itself a finding, and it belongs in
> Contributing factors too.
>
> State explicitly whether any data was lost, corrupted, or exposed. "No data loss" is a claim
> that needs the same evidence as any other; say how you know.

## Timeline

> All times UTC, absolute, one row per event. Include what was tried and did not work — the dead
> ends are the most reusable part of the report, because the next person will have the same idea.
>
> Two rows are mandatory and must be marked: **Detected** and **Mitigated**. The gap between the
> first row and Detected is your time-to-detect; the gap from Detected to Mitigated is your
> time-to-mitigate. They are different problems with different fixes, which is why they are marked
> separately.

| Time (UTC) | Event | Who / what |
|---|---|---|
| `HH:MM` | \<the change or condition that started it\> | \<deploy job, cron, traffic shift\> |
| `HH:MM` | **Detected** — \<how: alert, user report, someone noticed\> | \<alert name, or "user report"\> |
| `HH:MM` | \<first hypothesis, and what ruled it out\> | on-call |
| `HH:MM` | \<action taken\> | \<actor or system\> |
| `HH:MM` | **Mitigated** — \<what stopped the impact\> | \<rollback, flag, restart\> |
| `HH:MM` | \<fully resolved, backfill complete, verified\> | |

## Root cause

> The actual mechanism, traced back to the change or condition that introduced it. Link the commit,
> the migration, the configuration value, the dependency bump.
>
> **Distinguish the trigger from the cause.** A traffic spike that exposes an unbounded query is
> the trigger; the unbounded query is the cause. Stopping at the trigger produces a follow-up
> action about traffic and leaves the query in place.
>
> Keep asking "and why was that possible?" until you reach something you can change. If the answer
> bottoms out at "nothing checked for it", the root cause is the missing check.

## Contributing factors

> What made this worse, or slower to find, without causing it. One bullet each, concrete:
>
> - The alert that did not exist, or fired on the wrong signal, or was routed to a channel nobody
>   watches.
> - The log line that pointed at the wrong layer.
> - The test that covered the happy path only.
> - The dashboard that aggregates away the failing tenant.
> - The runbook that was out of date.
>
> These are usually where the real lessons are. The root cause is often a one-line fix; the
> contributing factors are why it took four hours.

## The fix

> What was changed, with the diff or the commit. Then state plainly which of these it is:
>
> - **Mitigation** — stopped the bleeding, the underlying defect is still there. Say what the
>   underlying defect is and link the issue tracking the real fix.
> - **Real fix** — the mechanism in Root cause can no longer occur.
>
> A rollback is a mitigation. A feature flag is a mitigation. Do not let a closed incident imply a
> closed defect.

## Verification

> How you know it is fixed. Evidence, not assertion.
>
> Name the test that now fails against the old code — a regression test that was never seen failing
> proves nothing. Name the metric and the window you watched it over. Name the query you ran
> against the data. Paste the output.
>
> "Deployed and it looks fine" is not verification.

## Commits and files touched

| Commit | Files | What it does |
|---|---|---|
| `abc1234` | `path/to/file` | \<the fix, the test, the alert\> |
| `def5678` | `path/to/test` | \<the regression test, and what it asserts\> |

> Include the commit that *introduced* the defect as well, if it is identifiable. Not to attribute
> it — to make the report searchable from the blame view six months from now, which is one of the
> main ways anyone will ever find this file.

## Detection gap

> A human found this before a gate did. Why?
>
> Walk the gates and say which one should have caught it and did not: the unit, integration, or
> architecture tests; the E2E journey; the architecture tests; SonarQube; Gitleaks; CodeQL; the
> dependency audit; the migration review; code review; the staging smoke test. See
> [../definition-of-done.md](../definition-of-done.md) for the full list.
>
> Then say which of these is true, because the fix is different for each:
>
> - **No gate covers this class of failure** → the action is a new gate.
> - **A gate covers it but was not run on this change** → the action is a path filter or a trigger.
> - **A gate ran and passed something it should have blocked** → the action is that gate's
>   configuration, and this is the most serious of the three. Say so.
> - **It is genuinely not gateable** → say why, and what monitoring replaces the gate.
>
> If the honest answer is "nothing could have caught this automatically", write that. An invented
> gate is worse than an admitted gap.

## Lessons

> What changes as a result. Each lesson is a concrete, owned action with an issue link.
>
> **"We should be more careful" is not a lesson.** Neither is "improve testing", "better
> monitoring", or "communicate earlier". They name a feeling, assign it to nobody, and are
> unfalsifiable — six months later there is no way to tell whether they happened. If a lesson
> cannot be written as a change to a file, a gate, a hook, or a process with an owner, it is not
> ready to be a lesson yet.
>
> Good: "The `ItemsController` integration suite had no test for a page size above the configured
> maximum; added in #214, and the validator now bounds it."
>
> Also worth asking, per
> [../workflow.md](../workflow.md#improve-the-harness-not-just-the-code):
> *what change would have made this impossible?* Prefer a hook or a test to a paragraph. Prose is
> advisory; a gate is not.

## Follow-up actions

> Every action from Lessons, plus anything the fix deferred. An action with no owner and no issue
> is a wish. Leave this table in the report unticked and tick it as the issues close — the report
> is the record of whether the follow-up actually happened, which is the part most organisations
> skip.

| # | Action | Owner | Issue | Done |
|---|---|---|---|:--:|
| 1 | \<concrete change\> | \<name\> | [#NNN](https://github.com/\<your-org\>/\<repo\>/issues/NNN) | [ ] |
| 2 | \<the gate that should have caught it\> | \<name\> | [#NNN](https://github.com/\<your-org\>/\<repo\>/issues/NNN) | [ ] |
| 3 | \<the alert or log that was missing\> | \<name\> | [#NNN](https://github.com/\<your-org\>/\<repo\>/issues/NNN) | [ ] |

---

## Review

> An incident report is reviewed by someone who was not involved, for the same reason code is:
> the author cannot see what they assumed. The reviewer's job is to ask whether the Root cause
> actually explains the Symptom, whether Verification is evidence, and whether every Lesson is an
> action.
>
> Set **Status: Reviewed** when that has happened. Until then it is a Draft, and a Draft is not
> something to link people to as an explanation.
