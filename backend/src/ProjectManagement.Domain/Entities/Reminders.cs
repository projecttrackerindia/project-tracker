using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>
    /// Where a reminder came from. Personal: the person asked for it. Nudge: someone else asked for it to reach them. DueDate, Overdue and
    /// Escalation are made by the system from dated work (and taken back again when the work is finished or moved).
    /// </summary>
    public enum ReminderSource { Personal, Nudge, DueDate, Overdue, Escalation }

    /// <summary>
    /// Scheduled: waiting for its time (possibly snoozed). Fired: its time came and it waits for the person to act. Done: finished.
    /// Cancelled: dismissed, or its work went away; never fires and is not shown.
    /// </summary>
    public enum ReminderState { Scheduled, Fired, Done, Cancelled }

    /// <summary>What a reminder is about. None: a free note ("call the bank").</summary>
    public enum ReminderTarget { None, Task, Issue, ActionItem, Operational, Milestone, ChatMessage }
}

namespace ProjectManagement.Domain.Entities
{
    using ProjectManagement.Domain.Enums;

    /// <summary>
    /// One reminder for one person in one workspace. Its time is kept the way the person meant it - a wall-clock time in a time zone, a
    /// day relative to its work's due date, or a repeating rule - and turned into <see cref="NextFireAt"/> (UTC) for the scheduler, so
    /// "09:00" stays 09:00 through daylight saving and moving due dates. Automatic reminders carry a <see cref="SystemKey"/> that says
    /// which date and step they stand for, so the planner neither repeats nor brings back one the person dismissed.
    /// </summary>
    public class Reminder : TenantEntity, ITenantScoped
    {
        /// <summary>Who is reminded.</summary>
        public Guid UserId { get; set; }
        public ReminderSource Source { get; set; }
        public string Title { get; set; } = "";
        public string? Note { get; set; }

        public ReminderTarget TargetType { get; set; }
        public Guid? TargetId { get; set; }
        /// <summary>Kept for display (ATL-12, WT-4) so the list never needs to read every item.</summary>
        public string? TargetKey { get; set; }
        public string? TargetTitle { get; set; }
        public Guid? TargetProjectId { get; set; }
        /// <summary>Where the work lives in the app ("/projects/..?task=..").</summary>
        public string? Link { get; set; }

        // ---- when
        /// <summary>The IANA time zone the wall-clock times below are in (the device's zone when the person set it).</summary>
        public string TimeZone { get; set; } = "UTC";
        /// <summary>
        /// A fixed moment as the person wrote it, "yyyy-MM-ddTHH:mm" in <see cref="TimeZone"/> (kept as text: it is a wall-clock time, not an
        /// instant). For a repeating reminder: its first occurrence, which the rule counts from.
        /// </summary>
        public string? LocalAt { get; set; }
        /// <summary>Relative to the work's due date: days from it (negative = before) at <see cref="AnchorTime"/>.</summary>
        public int? AnchorDays { get; set; }
        public TimeOnly? AnchorTime { get; set; }
        /// <summary>Repeating: an RFC 5545 RRULE subset (FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY, BYMONTHDAY, BYSETPOS=-1).</summary>
        public string? Recurrence { get; set; }
        /// <summary>Stop when the work it is about is finished.</summary>
        public bool OnlyIfOpen { get; set; } = true;
        /// <summary>Delivered at its exact time even in quiet hours (the person chose that time). Automatic reminders wait for working hours.</summary>
        public bool Exact { get; set; } = true;

        // ---- state
        public ReminderState State { get; set; } = ReminderState.Scheduled;
        /// <summary>The next time it goes off (UTC). Null when nothing is left to fire.</summary>
        public DateTime? NextFireAt { get; set; }
        public bool IsSnoozed { get; set; }
        public int SnoozeCount { get; set; }
        public int FireCount { get; set; }
        public DateTime? LastFiredAt { get; set; }
        /// <summary>Fired but not announced: over the person's daily limit for automatic reminders, so it waits in the morning briefing.</summary>
        public bool Quiet { get; set; }
        public DateTime? CompletedAt { get; set; }
        /// <summary>For an occurrence of a repeating reminder that was completed: the series it came from.</summary>
        public Guid? SeriesId { get; set; }

        /// <summary>Automatic reminders: "auto:{kind}:{item}:{user}:{step}:{due}". Unique per workspace.</summary>
        public string? SystemKey { get; set; }

        // ---- delivery
        /// <summary>A scheduler claims a reminder before firing it, so two servers never send the same one.</summary>
        public Guid? LockToken { get; set; }
        public DateTime? LockedUntil { get; set; }
        /// <summary>The one-time key in the links of the last notification (e-mail, push); only its hash is kept.</summary>
        public string? ActionTokenHash { get; set; }
        public DateTime? ActionTokenExpiresAt { get; set; }
    }

    /// <summary>How reminders behave for one person (in every workspace). No row = the defaults.</summary>
    public class ReminderSettings : Entity
    {
        public Guid UserId { get; set; }
        /// <summary>ISO weekdays that are working days ("1,2,3,4,5" = Monday to Friday).</summary>
        public string WorkDays { get; set; } = "1,2,3,4,5";
        public TimeOnly WorkStart { get; set; } = new(9, 0);
        public TimeOnly WorkEnd { get; set; } = new(18, 0);
        /// <summary>Nothing automatic arrives between these (null = no quiet hours). May run past midnight.</summary>
        public TimeOnly? QuietStart { get; set; } = new(21, 0);
        public TimeOnly? QuietEnd { get; set; } = new(8, 0);
        /// <summary>The time used when only a day is given ("tomorrow").</summary>
        public TimeOnly DefaultTime { get; set; } = new(9, 0);

        public bool AutoEnabled { get; set; } = true;
        /// <summary>Working days before a due date to be reminded, e.g. "1,0" = the working day before and the day itself.</summary>
        public string DueLeads { get; set; } = "1,0";
        /// <summary>Days after a missed due date for follow-ups, e.g. "1,3,7".</summary>
        public string OverdueSteps { get; set; } = "1,3,7";
        /// <summary>At most this many automatic reminders announced a day; the rest wait in the briefing.</summary>
        public int DailyAutoLimit { get; set; } = 12;

        public bool BriefingEnabled { get; set; } = true;
        public TimeOnly BriefingTime { get; set; } = new(8, 30);
        /// <summary>The local day of the last briefing ("yyyyMMdd"), so one goes out per day.</summary>
        public string? LastBriefingDay { get; set; }

        /// <summary>Keep the profile's time zone in step with the device the person uses.</summary>
        public bool FollowDeviceTimeZone { get; set; } = true;
        /// <summary>Refuse reminders from other people.</summary>
        public bool MuteNudges { get; set; }
    }

    /// <summary>
    /// A workspace's escalation ladder for overdue work (Business plans): who else hears about it, and after how many days. Steps are
    /// "days:who" pairs, e.g. "2:Manager,5:Owner" - Manager is the assignee's manager, Owner the project owner (or who raised operational work).
    /// </summary>
    public class ReminderPolicy : TenantEntity, ITenantScoped
    {
        public bool EscalationEnabled { get; set; }
        public string Steps { get; set; } = "2:Manager,5:Owner";
    }
}
