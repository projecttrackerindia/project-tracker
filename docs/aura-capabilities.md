# Aura (the in-app assistant) — capabilities

Aura is the assistant formerly called Groot. Code names (`AiAgent`, `AiToolbox`, `GrootIdentity`, …) are unchanged here; the rename is a separate change.

Goal: anything a person can do in the app, they can ask Aura to do, **within their own permissions**. Every change goes through the same application services the screens use, as the signed-in person, so permissions, `OrgGrantGuard`/project access, validation, plan limits, notifications, version stamps, due-date-move reasons and the audit trail all apply. Nothing in this document adds a path around authorization.

## How a request becomes changes

1. **Read tools** run immediately, as the person (they see only what the person can see).
2. **Write tools** never change anything: they return a *proposal* (a card) with a one-line title and a human summary (`AiProposal`, stored on the assistant message).
3. A multi-part request produces several cards in one answer, in order (`show_plan` shows the steps first). That list *is the plan*:
   - `GET /api/v1/ai/messages/{id}/plan` — every step in order: index, kind, title, summary, status, `undoable`, `undoNote`. Nothing runs. **(new)**
   - `POST /api/v1/ai/messages/{id}/actions/run` — confirms the plan: runs the waiting steps in order, each exactly as if confirmed alone; stops at the first failure and returns `outcome` (`succeeded` / `partial` / `failed`), `completed` (step ids that took effect), `failedStepId`, per-step results and `undoUntil`. **(new)**
   - `POST /api/v1/ai/messages/{id}/actions/undo-all` — undoes every undoable step of the run, newest first, within the 10-minute window; steps that cannot be undone are kept and said so; stops at the first failed reversal. **(new)**
   - Existing, unchanged: `POST …/actions/{actionId}/confirm`, `…/dismiss`, `…/undo`, `…/reconcile`, `POST …/actions/confirm-all`.
4. **Autonomy**: only `AiToolbox.AutoExecuteKinds` (`create_document`, private to its author) and explicit project/stage date updates authorised word-for-word by `AiExecutionPolicy` run without a card. The plan's AI level (`AiPlanLevels.Actions`), the workspace switch (`Tenant.AiDisabled`) and the agent levels (`AiAgentGate`, Off / Ask first / Auto, for the background agents) are respected as before. None of the new kinds auto-run.
5. **Plan binding**: each card is bound to tenant, user, payload hash and a 24-hour expiry (`AiActionPlan`); a changed payload or another user cannot confirm it.
6. **Audit**: every executed step writes `ai.action_confirmed` (or `ai.action_auto`) to the audit log with `UserId` = the person and `newValue` `{ kind, title, via: "assistant", actorId, messageId, actionId }`; undo writes `ai.action_undone` the same way. The underlying service writes its own activity/audit rows (e.g. `issue.reported`, `meeting.rescheduled`, `attendance.checked_in`) as the person.
7. **Assignees**: at confirmation, a proposal that gives work to someone (`assigneeId`) is refused if that person is suspended or no longer active; suspended members are also no longer offered to the model when it resolves names (`AiToolbox.PeopleAsync`).

## Inventory: what existed before this change

| Area | Tools (model-facing) | Card kind → service | Undo |
|---|---|---|---|
| Find / read | `find_work`, `list_projects`, `project_report`, `team_workload`, `list_people`, `my_work_summary`, `portfolio_brief`, `portfolio_scenario`, `workload_balance`, `suggest_assignee`, `history_insights`, `search_documents`, `read_document`, `search_knowledge`, `read_knowledge`, `list_project_meetings`, `list_reminders`, `list_planned_leave`, `list_watches`, `needs_you`, `chat_catch_up`, `chat_search`, `portfolio_decisions`, `vault_find` (names only), `my_schedule`, `my_time`, `decision_log`, `mail_inbox`, `mail_read`, `show_plan` | — | — |
| Work items | `propose_create_task` / `_work` / `_action_item`, `propose_update_work` (status/move, assignee, dates incl. due-date reason, priority, title, description, estimate, comment), `propose_delete_work` | `create_task` → TaskService, `create_work` → WorkTaskService, `create_action_item` → ActionItemService, `update_work`, `delete_work` (bin) | yes (delete / put back / restore) |
| Projects | `propose_create_project`, `propose_update_project`, `propose_update_stage_dates`, `propose_schedule_project` | ProjectService | no |
| Time | `propose_log_time`, `propose_planned_leave`, `propose_submit_week`, `propose_review_timesheet` | TimeService, PlannedLeaveService, TimesheetApprovalService | log_time: yes |
| Reminders / watches | `propose_reminder`, `propose_update_reminder`, `revise_reminder_proposal`, `propose_watch`, `propose_stop_watch` | ReminderService, AiWatchService | reminder, watch: yes |
| Messages / mail | `propose_send_message`, `propose_chat_reply`, `propose_mail_reply`, `propose_mail_forward`, `propose_send_report` | ChatService, MailboxService, email | no (left the building) |
| Meetings / calls | `propose_schedule_meeting`, `propose_start_meeting`, `propose_start_call` | MeetingService, CallService | no |
| Library | `propose_create_document`, `propose_edit_page`, `propose_page_comment` | DocumentService, DocumentCommentService | create_document: yes |
| Approvals / inbox | `propose_decide_agent_proposal`, `propose_clear_notification`, `propose_answer_check_in`, `propose_apply_portfolio_option` | AgentReviewService, NotificationService, AgentFollowUpService, PortfolioBoardService | no |
| Vault | `propose_vault_request`, `propose_vault_share` | VaultService (never reveals values) | no |
| People | `propose_invite_member` | WorkspaceService | no |

## Gaps found, and what this change adds

| Gap | Added |
|---|---|
| No standalone comment (only as a side effect of `update_work`) | `propose_add_comment` → `add_comment` |
| Bugs (stage/test issues) could not be reported or moved (`update_work` refuses issue keys) | `propose_report_issue` → `create_issue`, `propose_update_issue` → `update_issue` |
| Time entries could be logged but not edited; no tool exposed entry ids | `list_my_time_entries`, `propose_edit_time_entry` → `update_time_entry` |
| No attendance | `propose_check_in` (Office / Home / ClientSite + place) → `check_in`, `propose_check_out` → `check_out` |
| Meetings could be created but not rescheduled or edited; `list_project_meetings` gave no ids | meeting ids in `list_project_meetings`; `propose_reschedule_meeting`, `propose_update_meeting` |
| Quality: no test cases/results | `propose_create_test_case`, `propose_record_test_result` |
| Document approvals (as an approver) | `list_my_approvals`, `propose_decide_document_review` |
| Destructive/sensitive asks had no defined answer | `where_to_do_it` read tool: names the page to do it by hand, never a card |
| Plan as one unit | plan / run / undo-all endpoints above; `undoable` + `undoNote` on every card (`AiActionDto`, additive fields) |
| Audit lacked "via" | `via: "assistant"`, `actorId`, result id on every assistant audit row |
| Suspended members could be named as assignees | refused at proposal (not offered) and at confirmation |

## Capability table (new actions)

| Action (card kind) | Tool | Service used (as the person) | Extra gate checked (mirrors the screen's controller) | Undoable? |
|---|---|---|---|---|
| `add_comment` | `propose_add_comment` | `TaskService.AddCommentAsync` / `WorkTaskService.AddCommentAsync` | Tasks ≥ Edit / Work ≥ Edit | yes — deletes the comment |
| `create_issue` | `propose_report_issue` | `IssueService.CreateAsync` | Projects ≥ View, Tasks ≥ View, `tasks.comment` | yes — deletes the issue |
| `update_issue` | `propose_update_issue` | `IssueService.AssignAsync` + `ChangeStatusAsync` (issue move rules) | Projects/Tasks ≥ View | yes — earlier status + assignee |
| `update_time_entry` | `propose_edit_time_entry` | `TimeService.UpdateAsync` (closed weeks, day capacity) | own entries only | yes — earlier minutes/day/note |
| `check_in` | `propose_check_in` | `AttendanceService.CheckInAsync` | org workspace, policy on | no |
| `check_out` | `propose_check_out` | `AttendanceService.CheckOutAsync` | — | no |
| `reschedule_meeting` | `propose_reschedule_meeting` | `MeetingService.RescheduleAsync` (organizer or editor) | project visible | yes — moves it back (attendees told again) |
| `update_meeting` | `propose_update_meeting` | `MeetingService.UpdateDetailsAsync` (Project Tracker meetings only) | project visible | yes — earlier title/agenda |
| `create_test_case` | `propose_create_test_case` | `QualityService.CreateCaseAsync` | Work ≥ Edit | no (Quality has no delete) |
| `record_test_result` | `propose_record_test_result` | `QualityService.SetResultAsync` | Work ≥ Edit | no |
| `decide_document_review` | `propose_decide_document_review` | `DocumentWorkflowService.ApproveAsync` / `RequestChangesAsync` | must be the current step's reviewer; Documents ≥ View | no |
| — | `where_to_do_it` | none (answer only) | — | — |

Messages (`send_message`, `chat_reply`) stay **not undoable**: the existing design treats a sent message as having left the building, and chat has no unsend window to honour.

## Never done by Aura (link to do it by hand)

Deleting/archiving projects, removing or suspending members, bulk deletes, billing, security settings (SSO, passwords, sessions, API keys), revealing vault secrets. `where_to_do_it` returns the page; no card is ever produced.

## Not covered yet

- **Focus time**: the app has no focus-time entity (the timeline only *computes* focus blocks), so there is nothing to set without a new model and migration.
- **Document access requests** (`DocumentAccessRequestService.DecideAsync`) and **leave approval**: no list of pending requests for a decider is exposed to the assistant yet.
- **Workspace (non-project) meetings** reschedule/edit: only project meetings are covered.
- **Bulk changes** across many items are intentionally not offered.
- Front-end: the new `undoable` / `undoNote` fields and the plan / run / undo-all endpoints need UI (the Aura UI work is on `aura-ui`).
