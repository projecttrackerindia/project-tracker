using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>Where something the project agent read came from.</summary>
    public enum AgentSourceKind { ProjectMailbox, PersonalMail, Chat, MeetingTranscript, LiveMeeting, Manual, Slack, WhatsApp }

    /// <summary>
    /// What the agent proposes. The first five change work when approved; Delay, Suggestion, Missed and Decision are notes for the team that are
    /// recorded (and included in the people's updates) when approved.
    /// </summary>
    public enum AgentFindingKind { CreateTask, UpdateTask, CreateActionItem, CreateIssue, UpdateIssue, Delay, Suggestion, Missed, Decision }

    public enum AgentFindingStatus { Proposed, Applied, Dismissed, Failed }
}

namespace ProjectManagement.Domain.Entities
{
    using ProjectManagement.Domain.Enums;

    /// <summary>
    /// The project agent of one project: what it may read, and its own mailbox address (agent+token@...). It never changes anything by itself:
    /// everything it finds waits as an <see cref="AgentFinding"/> until someone who may edit the project approves it.
    /// </summary>
    public class ProjectAgentSettings : TenantEntity, ITenantScoped
    {
        public Guid ProjectId { get; set; }
        public bool Enabled { get; set; }
        /// <summary>24 lowercase hex characters; mail to agent+{token}@{InboundEmail:Domain} lands in this project.</summary>
        public string MailboxToken { get; set; } = "";
        public bool ReadMailbox { get; set; } = true;
        public bool ReadChat { get; set; } = true;
        public bool ReadMeetings { get; set; } = true;
        /// <summary>Send the live meeting bot to this project's stand-ups (needs the workspace's meeting-bot key).</summary>
        public bool LiveBot { get; set; }
        /// <summary>Each morning, send everyone with work in the project their own update.</summary>
        public bool DailyUpdates { get; set; } = true;
        /// <summary>Who switched it on: background runs act as this person (their rights, the workspace's AI credits).</summary>
        public Guid ActingUserId { get; set; }
        public DateTime? ChatReadUntil { get; set; }
        public DateTime? LastRunAt { get; set; }
        /// <summary>yyyy-MM of <see cref="RunsThisMonth"/>.</summary>
        public string? RunMonth { get; set; }
        public int RunsThisMonth { get; set; }
        public int MonthlyRunLimit { get; set; } = 300;
        /// <summary>The workspace day (yyyyMMdd) the daily updates were last sent for.</summary>
        public string? DailySentDay { get; set; }
        public int MailReceived { get; set; }
        public string? LastError { get; set; }
        /// <summary>The project lead's notes for the agent: names, terms and abbreviations, how the team works, what to ignore.</summary>
        public string? Instructions { get; set; }
        /// <summary>Who is who in calls and chat: one "name heard = person's e-mail" per line (nicknames, short names, how captions spell them).</summary>
        public string? SpeakerAliases { get; set; }
        /// <summary>The language people speak in the meetings (BCP-47, e.g. en-IN, hi-IN); the bot sets Meet's captions to it.</summary>
        public string? CaptionLanguage { get; set; }
        /// <summary>Also send the bot to Google Meet calls on the acting person's calendar that name the project (key or name in the title).</summary>
        public bool AutoJoinCalendar { get; set; }
        /// <summary>When everything from a meeting has been decided, send the minutes to the people in it.</summary>
        public bool SendMinutes { get; set; } = true;
        /// <summary>The Slack channel (id, e.g. C0123ABCD) read like the project chat; needs the workspace's Slack app with channel reading.</summary>
        public string? SlackChannelId { get; set; }
        /// <summary>The Slack timestamp of the last channel message read.</summary>
        public string? SlackReadUntil { get; set; }
        /// <summary>Read WhatsApp messages that start with the project key ("PAY: ...") from members with a verified WhatsApp number.</summary>
        public bool ReadWhatsApp { get; set; } = true;
    }

    /// <summary>Something the agent will read: an e-mail, a stretch of chat, a meeting transcript. The content is stored encrypted.</summary>
    public class AgentSignal : TenantEntity, ITenantScoped
    {
        public Guid ProjectId { get; set; }
        public AgentSourceKind Source { get; set; }
        /// <summary>Stable reference for de-duplication (message id, meeting id + day, chat window).</summary>
        public string SourceRef { get; set; } = "";
        public string Title { get; set; } = "";
        public string? FromName { get; set; }
        public string ContentProtected { get; set; } = "";
        public int Length { get; set; }
        public DateTime OccurredAt { get; set; }
        /// <summary>Whose private inbox it came from (personal mail only).</summary>
        public Guid? OwnerUserId { get; set; }
        public Guid? MeetingId { get; set; }
        public DateTime? ProcessedAt { get; set; }
        public Guid? RunId { get; set; }
    }

    /// <summary>One time the agent read new signals and wrote findings.</summary>
    public class AgentRun : TenantEntity, ITenantScoped
    {
        public Guid ProjectId { get; set; }
        /// <summary>schedule, meeting, mail, manual.</summary>
        public string Trigger { get; set; } = "";
        /// <summary>running, done, failed.</summary>
        public string Status { get; set; } = "running";
        public int SignalCount { get; set; }
        public int FindingCount { get; set; }
        public int Credits { get; set; }
        public string? Summary { get; set; }
        public string? Error { get; set; }
        public DateTime StartedAt { get; set; }
        public DateTime? FinishedAt { get; set; }
        public Guid? MeetingId { get; set; }
        /// <summary>When the minutes of the meeting this reading was about went out (once everything in it was decided).</summary>
        public DateTime? MinutesSentAt { get; set; }
    }

    /// <summary>One proposal or note from the agent, with the words it came from; waits for a person's decision.</summary>
    public class AgentFinding : TenantEntity, ITenantScoped
    {
        public Guid ProjectId { get; set; }
        public Guid RunId { get; set; }
        public Guid? SignalId { get; set; }
        public AgentFindingKind Kind { get; set; }
        public AgentFindingStatus Status { get; set; } = AgentFindingStatus.Proposed;
        public string Title { get; set; } = "";
        public string? Detail { get; set; }
        /// <summary>A short quote from the source.</summary>
        public string? Evidence { get; set; }
        /// <summary>"Email from Ravi · 18 Oct", "Stand-up 18 Oct", "Project chat".</summary>
        public string? SourceLabel { get; set; }
        /// <summary>The existing task (UpdateTask, Delay) or issue (UpdateIssue) it is about.</summary>
        public Guid? TaskId { get; set; }
        public Guid? IssueId { get; set; }
        public Guid? AssigneeId { get; set; }
        public DateOnly? DueDate { get; set; }
        public Priority? Priority { get; set; }
        /// <summary>For UpdateTask: todo, in_progress, done. For UpdateIssue: in_progress, fixed, resolved.</summary>
        public string? NewStatus { get; set; }
        /// <summary>A comment to add to the task or issue.</summary>
        public string? Comment { get; set; }
        public int Confidence { get; set; }
        public Guid? DecidedBy { get; set; }
        public DateTime? DecidedAt { get; set; }
        /// <summary>The task, action item or issue it created or changed.</summary>
        public Guid? AppliedEntityId { get; set; }
        public string? AppliedKey { get; set; }
        public string? Error { get; set; }
        /// <summary>False when the quoted words were not found in the source (shown as "check the source"; confidence is lowered).</summary>
        public bool Grounded { get; set; } = true;
        /// <summary>What the approver changed before approving ("title, assignee"), so the agent learns how the team wants things.</summary>
        public string? Edits { get; set; }
        /// <summary>What the agent first proposed as the title, when the approver changed it.</summary>
        public string? OriginalTitle { get; set; }
        /// <summary>The assignee's answer to work the agent gave them: accepted or declined.</summary>
        public string? OwnerResponse { get; set; }
        public DateTime? OwnerRespondedAt { get; set; }
        public string? OwnerNote { get; set; }
    }

    /// <summary>How the workspace's live meeting bot appears and behaves (the bot itself is the installation's own service, apps/meetbot).</summary>
    public class AgentWorkspaceSettings : TenantEntity, ITenantScoped
    {
        /// <summary>Unused: kept from when the bot was a third-party service, so no data migration was needed.</summary>
        public string? RecallApiKeyProtected { get; set; }
        /// <summary>Unused (see <see cref="RecallApiKeyProtected"/>).</summary>
        public string RecallRegion { get; set; } = "us-west-2";
        public string BotName { get; set; } = "Project Tracker Agent";
        /// <summary>Post short reminders in the meeting chat while people talk.</summary>
        public bool InCallReminders { get; set; } = true;
    }

    /// <summary>
    /// The agent's part in one session of a project meeting: our live bot sent to it (Kind "bot"), or fetching Google Meet's own transcript
    /// once the session has ended (Kind "meet").
    /// </summary>
    public class AgentMeetingBot : TenantEntity, ITenantScoped
    {
        public Guid ProjectId { get; set; }
        public Guid MeetingId { get; set; }
        public DateTime SessionStartUtc { get; set; }
        public DateTime SessionEndUtc { get; set; }
        /// <summary>bot or meet.</summary>
        public string Kind { get; set; } = "bot";
        /// <summary>The bot service's id for the bot (bot only).</summary>
        public string BotId { get; set; } = "";
        public DateTime? LastAttemptAt { get; set; }
        public int Attempts { get; set; }
        /// <summary>scheduled, in_call, done, failed (bot); waiting, done, failed (meet).</summary>
        public string Status { get; set; } = "scheduled";
        /// <summary>32 hex characters in the webhook address the bot service calls.</summary>
        public string WebhookToken { get; set; } = "";
        /// <summary>The words so far, "Speaker: text" lines, encrypted.</summary>
        public string? TranscriptProtected { get; set; }
        public int TranscriptLength { get; set; }
        public int CheckedLength { get; set; }
        public DateTime? LastNudgeAt { get; set; }
        public int NudgeCount { get; set; }
        /// <summary>What was already said in the meeting chat, so it is not said twice (one line each).</summary>
        public string? NudgesSent { get; set; }
        public DateTime? EndedAt { get; set; }
        public string? Error { get; set; }
        /// <summary>For a call found on the calendar (no project meeting): the calendar event, its title and Meet address.</summary>
        public string? CalendarEventId { get; set; }
        public string? Title { get; set; }
        public string? MeetUrl { get; set; }
        /// <summary>The bot worker (apps/meetbot) that holds this session, while it holds it (bot only).</summary>
        public string? WorkerId { get; set; }
        /// <summary>Until when the worker holds it: a worker that stops reporting loses the session and another worker joins instead.</summary>
        public DateTime? LeaseUntil { get; set; }
        /// <summary>What the worker last said about the bot: joining, waiting_admission, in_call_recording, call_ended, done or fatal.</summary>
        public string? WorkerStatus { get; set; }
        /// <summary>Messages waiting to be posted in the meeting chat (one per line), collected by the worker on its next report.</summary>
        public string? PendingChat { get; set; }
        /// <summary>What a worker needs to join (JSON: Meet address, bot name, hello, agenda, caption language), set when the session is queued.</summary>
        public string? JoinPayload { get; set; }
    }

    /// <summary>
    /// A meeting-bot worker (apps/meetbot) that reported recently: how many meetings it can attend at once and how many it is in. Workers ask
    /// for sessions themselves, so any number of them (replicas) can run behind one address.
    /// </summary>
    public class AgentBotWorker : AuditableEntity
    {
        public string WorkerKey { get; set; } = "";
        public string? Host { get; set; }
        public string? Version { get; set; }
        public int Capacity { get; set; }
        public int Active { get; set; }
        public bool Draining { get; set; }
        public DateTime LastSeenAt { get; set; }
    }

    /// <summary>A person's own opt-in: the agent may look in their connected Gmail or Outlook for mail about their projects.</summary>
    public class AgentInboxOptIn : TenantEntity, ITenantScoped
    {
        public Guid UserId { get; set; }
        /// <summary>google or microsoft.</summary>
        public string Provider { get; set; } = "";
        public bool Enabled { get; set; }
        public DateTime OptedInAt { get; set; }
        public DateTime? ScannedUntil { get; set; }
        public int Found { get; set; }
        public string? LastError { get; set; }
    }
}
