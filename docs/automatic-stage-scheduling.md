# Automatic stage scheduling

Open a project's **Schedule studio** from the timeline. Agile projects have the same button in the project toolbar.

1. Review the project start and end, then allocate a duration to every stage.
2. Use **Project end follows the final stage** (the default) to keep the project end aligned with the calculated finish. Extensions require a reason and enter delivery history.
3. Preview the entire plan, review each date, then apply it. Editing any preview input requires a matching preview before applying. A changed project version or stage snapshot expires the preview.

Durations are elapsed calendar days, including weekends: a stage starting January 1 with 4 days ends January 5. The next stage starts at that boundary. Zero days represents a milestone. The editor's arithmetic is date-only and independent of timezone and daylight-saving changes.

Moving a stage's start preserves its duration; changing its end changes its allocation. Downstream unfinished stages adjust in order. Moving the project start rebases the plan and preserves existing gaps. Editing only the project end schedules unfinished stages backward from that date without compressing allocations. The studio also supports anchoring a different end date. A deadline that cannot accommodate completed work and remaining durations is rejected without saving anything.

**Keep project end fixed** is available when the deadline must stay fixed. Remaining days appear as buffer, and overflow identifies the calculated finish and excess days. Users can extend the deadline, move a stage earlier, or reduce allocations explicitly. **Distribute available days** is an explicit allocation change; zero-day milestones and completed allocations are preserved.

Completed work plans are protected. The leading completed zero-day creation marker may reanchor its planned date when the project start moves; its actual completion history remains unchanged. Completed stages without recorded plans require a manual review before enabling automatic scheduling. Task deadlines, actual dates, ownership and dependency locks remain separate from planned stage scheduling.

Agent project/stage date operations use the same engine, require reasons for extensions, reject stale data and verify the saved result. A rejected or unverified operation rolls back SQL and tracked mutations before the failure card is recorded.

## Agent: questions, analysis and execution

The Agent distinguishes questions, analysis, recommendations, execution and combined requests. Clear informational requests have no write tools. Analysis uses current authorized project evidence; questions about updating stages do not create tasks or update proposals.

Routine project/stage date changes can execute directly when the current message explicitly names the exact project (and stage where applicable) and supplies the matching dates or allocation. For example, `Update Atlas start date to 2030-01-03 because Kickoff approved two days later and explain what changed` saves and verifies the schedule and retains the explanation in the answer. This policy is checked in the backend against the user's message, not delegated to the model. It accepts ISO, day-month-year and named-month dates. Ambiguous references, conditional requests, attachments, multiple commands and extra model-supplied changes retain confirmation. Existing permissions, subscriptions, extension reasons and audit rules still apply.

`propose_schedule_project` can enable automatic scheduling or recalculate every stage in one reviewed operation. It accepts the recorded allocations or an explicit complete list of stage durations, and previews every resulting date. It does not invent missing allocations. Changing the scheduling mode or allocating a whole timeline requires one confirmation with a current stage fingerprint. Repeating an unchanged pending timeline proposal points to its existing card; repeating saved values reports a verified no-op without another card or write. Whole-project stage scheduling does not silently alter task deadlines.

Supported dates and allocation updates are verified by querying persisted project and stage rows inside the write transaction. Completed plans, actual history and existing dependency locks are protected. Configurable holiday calendars, arbitrary dependency graphs and Agent tools for worked-time logging are not part of this release; the Agent must describe these limits accurately instead of claiming it executed them.

## Existing projects and database upgrade

Migration `20261013101012_AutomaticStageScheduling` adds `Projects.StageScheduleMode` with default `Manual` and nullable `ProjectStages.DurationDays`. Existing dates and actual history are preserved. Existing projects opt in through Schedule studio; dates supply initial allocations, which users must review. New projects with both dates use `FollowSchedule` and store their template allocations. Undated projects remain manual until dates and allocations are defined.

The reviewed SQLite additive upgrade is repeatable. PostgreSQL upgrade tests start at the preceding main migration, preserve an existing project/stage, and apply the new migration twice. Production rollout requires a current database backup, migration verification and API health before the new frontend is released.

## API

- `POST /api/v1/projects/{id}/schedule/preview`: `version`, `mode`, `startDate`, `dueDate`, every stage's `id` and `durationDays`, optional `reason`; returns calculated dates, buffer and a stage snapshot fingerprint.
- `PUT /api/v1/projects/{id}/schedule`: same body plus `expectedFingerprint` from the preview. Permissions and validation run again inside the save transaction.
- Stage create/update accepts `durationDays`, `scheduleReason` and `projectVersion`. Stage reordering accepts `projectVersion` and optional `scheduleReason`; deletion accepts `projectVersion` in the query.

All operations use the existing tenant/project permissions. Preview makes no changes. Schedule dates, allocations, project end, delivery history and audit records save together. Conflicts return 409; invalid schedules and missing extension reasons return actionable field validation.
