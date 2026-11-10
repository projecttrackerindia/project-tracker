using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Excerpts and minutes text, the small pure pieces of meaning search over chat, meetings and mail.</summary>
public class AiSemanticSourcesPrimitivesTests
{
    [Fact]
    public void An_excerpt_is_cut_around_the_words_asked_for_and_never_runs_long()
    {
        var text = string.Join(" ", Enumerable.Range(1, 80).Select(i => $"filler{i}")) + " the refund window is seven days " + string.Join(" ", Enumerable.Range(1, 80).Select(i => $"tail{i}"));
        var excerpt = AiSemanticSources.Excerpt(text, "refund window", 200);
        Assert.Contains("refund window", excerpt);
        Assert.True(excerpt.Length <= 205, excerpt.Length.ToString());
        Assert.StartsWith("…", excerpt);
        Assert.EndsWith("…", excerpt);
    }

    [Fact]
    public void An_excerpt_with_no_shared_word_is_the_start_and_short_text_is_whole()
    {
        Assert.Equal("Customers get money back.", AiSemanticSources.Excerpt("Customers\nget money   back.", "refund rule", 280));
        var long_ = new string('x', 50) + " " + string.Join(" ", Enumerable.Repeat("word", 200));
        var excerpt = AiSemanticSources.Excerpt(long_, "refund rule", 100);
        Assert.StartsWith("xxxx", excerpt);
        Assert.EndsWith("…", excerpt);
    }

    [Fact]
    public void Minutes_become_plain_lines_with_decisions_actions_and_risks()
    {
        var text = AiSemanticIndex.MinutesToText(new MinutesContent("Refund sync", "We agreed a refund rule.", ["Ravi", "Max"], ["Window length debated"], ["Seven days"],
            [new MinutesActionItem("Update the policy page", "Ravi", "Friday")], ["Edge cases unclear"], null));
        Assert.Contains("We agreed a refund rule.", text);
        Assert.Contains("Decision: Seven days", text);
        Assert.Contains("Action: Update the policy page (Ravi) by Friday", text);
        Assert.Contains("Risk: Edge cases unclear", text);
    }
}

/// <summary>
/// Meaning-based search over chat, meeting notes and project mail: found together with the word results, never beyond what the person can open
/// now, and never an error when the embedding model is off or failing.
/// </summary>
public partial class AiWorkspaceTests
{
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    private Task<string> Knowledge(TestClient who, string query) => RunTool(who, AiToolbox.SearchKnowledge, new { query }, $"Find what we know about: {query}");

    private async Task<string> Say(TestClient from, string conversation, string body)
    {
        var sent = await from.Post($"/api/v1/chat/conversations/{conversation}/messages", new { body });
        Assert.True(sent.Ok, sent.ToString());
        return S(sent.Data!["id"]);
    }

    [Fact]
    public async Task Chat_messages_are_found_by_meaning_only_by_people_in_that_conversation_and_never_from_private_chats()
    {
        var o = await Setup();
        var ravi = await o.Owner.AddMemberAsync(factory, TenantRole.Member, "Ravi Member");
        var ownerChat = S((await o.Manager.Post("/api/v1/chat/conversations/direct", new { userId = o.Owner.UserId })).Data!["id"]);
        var raviChat = S((await o.Manager.Post("/api/v1/chat/conversations/direct", new { userId = ravi.UserId })).Data!["id"]);
        var group = S((await o.Manager.Post("/api/v1/chat/conversations/group", new { name = "Returns crew", memberIds = new[] { o.Owner.UserId, ravi.UserId } })).Data!["id"]);
        var quiet = S((await o.Manager.Post("/api/v1/chat/conversations/group", new { name = "Quiet room", memberIds = new[] { o.Owner.UserId, ravi.UserId } })).Data!["id"]);

        var toOwner = await Say(o.Manager, ownerChat, "Our refund rule is that customers get their money back within seven days of purchase.");
        var toRavi = await Say(o.Manager, raviChat, "Between us: the refund rule for VIP accounts is a secret exception, money back after thirty days.");
        var inGroup = await Say(o.Manager, group, "Group reminder: the money back window stays at seven days, that is the policy for everyone.");
        var inQuiet = await Say(o.Manager, quiet, "Quiet room: refund rule drafts live here, money back for staff purchases.");
        await Say(o.Manager, ownerChat, "ok thanks");   // too short to mean anything: not indexed
        Assert.True(await IndexForMeaning() >= 4);
        Assert.Equal(4, factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Count(c => c.SourceKind == "chat" && c.TenantId == o.Owner.WorkspaceId)));
        var piece = factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Single(c => c.SourceId == Guid.Parse(toRavi)));
        Assert.Equal(Guid.Parse(raviChat), piece.ConversationId);
        Assert.Equal(o.Owner.WorkspaceId, piece.TenantId);

        // Olivia is in the direct chat with Max, the group and the quiet room - not in the one between Max and Ravi.
        var seen = await Knowledge(o.Owner, "What's our refund rule?");
        Assert.Contains(toOwner, seen);
        Assert.Contains(inGroup, seen);
        Assert.Contains($"/messages/{ownerChat}?m={toOwner}", seen);
        Assert.Contains("money back within seven days", seen);   // a short excerpt of the message itself
        Assert.DoesNotContain(toRavi, seen);
        Assert.DoesNotContain("secret exception", seen);
        // Ravi: his own chat and the group, not Olivia's chat with Max.
        var raviSeen = await Knowledge(ravi, "What's our refund rule?");
        Assert.Contains(toRavi, raviSeen);
        Assert.DoesNotContain(toOwner, raviSeen);

        // The ask bar's list is the same search, with an excerpt and a link, and the same limits.
        var bar = (await o.Owner.Get("/api/v1/search/meaning?q=refund%20rule")).Data!;
        var lines = bar["items"]!.AsArray();
        var line = Assert.Single(lines, x => S(x!["id"]) == toOwner)!;
        Assert.Equal("chat", S(line["kind"]));
        Assert.Contains("money back", S(line["excerpt"]));
        Assert.StartsWith("/messages/", S(line["link"]));
        Assert.DoesNotContain(lines, x => S(x!["id"]) == toRavi);

        // Access is checked when it is read, not when it was indexed: Olivia leaves the group, and the room turns into a private chat.
        factory.WithDb(db =>
        {
            db.ConversationMembers.IgnoreQueryFilters().Where(m => m.ConversationId == Guid.Parse(group) && m.UserId == o.Owner.UserId).ExecuteDelete();
            db.Conversations.IgnoreQueryFilters().Where(c => c.Id == Guid.Parse(quiet)).ExecuteUpdate(u => u.SetProperty(c => c.IsPrivate, true));
            return 0;
        });
        var later = await Knowledge(o.Owner, "What's our refund rule?");
        Assert.Contains(toOwner, later);
        Assert.DoesNotContain(inGroup, later);
        Assert.DoesNotContain(inQuiet, later);
        Assert.DoesNotContain(inQuiet, await Knowledge(ravi, "refund rule drafts for staff purchases, money back"));
        Assert.DoesNotContain(inQuiet, await Knowledge(o.Manager, "refund rule drafts for staff purchases, money back"));

        // A message deleted later is gone at once for readers, and leaves the index on the next pass.
        factory.WithDb(db => db.ChatMessages.IgnoreQueryFilters().Where(m => m.Id == Guid.Parse(toOwner)).ExecuteUpdate(u => u.SetProperty(m => m.DeletedAt, DateTime.UtcNow).SetProperty(m => m.Body, "")));
        Assert.DoesNotContain(toOwner, await Knowledge(o.Owner, "What's our refund rule?"));
        await IndexForMeaning();
        Assert.False(factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Any(c => c.SourceId == Guid.Parse(toOwner) || c.SourceId == Guid.Parse(inQuiet))));   // the private room's piece left too

        // Another workspace never sees any of it.
        var stranger = await TestClient.RegisterAsync(factory, "Stranger Sam"); await stranger.CreateOrgAsync();
        Assert.Empty((await stranger.Get("/api/v1/search/meaning?q=refund%20rule")).Data!["items"]!.AsArray());
    }

    [Fact]
    public async Task A_private_encrypted_chat_is_never_indexed()
    {
        var o = await Setup();
        var chat = S((await o.Manager.Post("/api/v1/chat/conversations/direct", new { userId = o.Owner.UserId })).Data!["id"]);
        var id = Guid.Parse(await Say(o.Manager, chat, "Plain words about the refund rule and money back, sent before the chat turned private."));
        factory.WithDb(db => db.Conversations.IgnoreQueryFilters().Where(c => c.Id == Guid.Parse(chat)).ExecuteUpdate(u => u.SetProperty(c => c.IsPrivate, true)));
        await IndexForMeaning();
        Assert.False(factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Any(c => c.SourceId == id)));
        Assert.DoesNotContain(id.ToString(), await Knowledge(o.Owner, "refund rule money back"));
    }

    [Fact]
    public async Task Words_and_meaning_are_ranked_together_and_a_page_found_both_ways_comes_first()
    {
        var o = await Setup();
        var both = await PublishedPage(o.Owner, "Refund rule handbook", "Staff must follow this money back policy.");
        var meaningOnly = await PublishedPage(o.Owner, "Returns policy", "Customers get their money back within seven days.");
        await IndexForMeaning();
        var found = await Knowledge(o.Owner, "refund rule");
        Assert.Contains(both.ToString(), found);
        Assert.Contains(meaningOnly.ToString(), found);
        Assert.True(found.IndexOf(both.ToString(), StringComparison.Ordinal) < found.IndexOf(meaningOnly.ToString(), StringComparison.Ordinal), "the page found by words and meaning comes first");
        Assert.Contains("\"via\":\"both\"", found);
        Assert.Contains("\"via\":\"meaning\"", found);
        Assert.Contains("not proof of a claim", found);   // honest about what a match is
    }

    [Fact]
    public async Task Search_falls_back_to_words_without_an_error_when_the_embedding_model_is_off_or_failing()
    {
        var o = await Setup();
        var byWords = await PublishedPage(o.Owner, "Refund rule handbook", "Staff must follow this money back policy.");
        var meaningOnly = await PublishedPage(o.Owner, "Returns policy", "Customers get their money back within seven days.");
        await IndexForMeaning();
        try
        {
            factory.Embedder.Throw = true;   // the model fails
            var failing = await Knowledge(o.Owner, "refund rule");
            Assert.Contains(byWords.ToString(), failing);
            Assert.DoesNotContain(meaningOnly.ToString(), failing);
            Assert.Contains("authorized-keyword", failing);
            Assert.DoesNotContain("\"via\":\"meaning\"", failing);
            var bar = await o.Owner.Get("/api/v1/search/meaning?q=refund%20rule");
            Assert.True(bar.Ok, bar.ToString());
            Assert.Contains(bar.Data!["items"]!.AsArray(), x => S(x!["id"]) == byWords.ToString());
            Assert.False(bar.Data["meaning"]!.GetValue<bool>());

            factory.Embedder.Throw = false; factory.Embedder.Configured = false;   // no model at all
            var off = await Knowledge(o.Owner, "refund rule");
            Assert.Contains(byWords.ToString(), off);
            Assert.DoesNotContain(meaningOnly.ToString(), off);
            Assert.Equal(0, await IndexForMeaning());   // indexing is idle too
        }
        finally { factory.Embedder.Throw = false; factory.Embedder.Configured = true; }
        Assert.Contains(meaningOnly.ToString(), await Knowledge(o.Owner, "refund rule"));   // and meaning is back when the model is
    }

    [Fact]
    public async Task A_draft_page_and_a_page_with_an_explicit_deny_are_not_retrievable_by_meaning_by_the_person_they_are_hidden_from()
    {
        var o = await Setup();
        var denied = await PublishedPage(o.Owner, "Returns policy", "Customers get their money back within seven days.");
        Assert.True((await o.Owner.Post($"/api/v1/documents/{denied}/grants", new { principalType = "User", principalId = o.Manager.UserId, level = "Viewer", deny = true })).Ok);
        var type = Guid.Parse(S((await o.Owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "PAGE")!["id"]));
        var draft = await o.Owner.Post("/api/v1/documents", new { title = "Refund exceptions draft", typeId = type, visibility = "Private", sections = new[] { new { key = "body", content = Rich("Money back rule exceptions, not yet shared.") } } });
        Assert.True(draft.Ok, draft.ToString());
        var draftId = S(draft.Data!["item"]!["id"]);
        await IndexForMeaning();

        var mine = await Knowledge(o.Owner, "What's our refund rule?");
        Assert.Contains(denied.ToString(), mine);
        Assert.Contains(draftId, mine);
        var theirs = await Knowledge(o.Manager, "What's our refund rule?");
        Assert.DoesNotContain(denied.ToString(), theirs);
        Assert.DoesNotContain("Returns policy", theirs);
        Assert.DoesNotContain(draftId, theirs);
        Assert.DoesNotContain("Money back rule exceptions", theirs);
        var bar = (await o.Manager.Get("/api/v1/search/meaning?q=refund%20rule")).Data!["items"]!.AsArray();
        Assert.DoesNotContain(bar, x => S(x!["id"]) == denied.ToString() || S(x["id"]) == draftId);
    }

    [Fact]
    public async Task Project_mail_and_meeting_notes_are_found_by_meaning_only_by_the_people_who_may_open_them_and_their_words_are_not_copied_into_the_index()
    {
        var o = await Setup();
        var ravi = await o.Owner.AddMemberAsync(factory, TenantRole.Member, "Ravi Member");
        Assert.True((await o.Owner.Post($"/api/v1/projects/{o.Project}/members", new { userId = o.Manager.UserId })).Ok);
        var tenant = o.Owner.WorkspaceId; var now = DateTime.UtcNow;
        var bot = new AgentMeetingBot
        {
            TenantId = tenant, ProjectId = o.Project, MeetingId = Guid.NewGuid(), SessionStartUtc = now.AddHours(-2), SessionEndUtc = now.AddHours(-1), Kind = "bot", Status = "done",
            WebhookToken = Guid.NewGuid().ToString("N"), EndedAt = now.AddHours(-1), Title = "Returns sync", CreatedAt = now.AddHours(-2),
        };
        var signal = Guid.NewGuid();
        factory.WithDb(db =>
        {
            var secrets = factory.Services.GetRequiredService<ISecretProtector>();
            var spoken = "Ravi: the refund rule for annual plans needs a decision.\nMax: customers should get their money back within seven days.";
            bot.TranscriptProtected = secrets.Protect(spoken); bot.TranscriptLength = spoken.Length;
            db.AgentMeetingBots.Add(bot);
            db.AgentDelegations.Add(new AgentDelegation { TenantId = tenant, ProjectId = o.Project, MeetingId = bot.MeetingId, SessionStartUtc = bot.SessionStartUtc, SessionEndUtc = bot.SessionEndUtc,
                UserId = o.Owner.UserId, Status = "reported", BotRowId = bot.Id, CreatedAt = now });
            db.CallRooms.Add(new CallRoom { TenantId = tenant, Title = "Returns sync", RoomName = $"pt-{Guid.NewGuid():N}", Kind = "project", ProjectId = o.Project, StartedBy = o.Manager.UserId,
                StartedAt = now.AddHours(-2), EndedAt = now.AddHours(-1), Status = "ended", AgentSessionId = bot.Id });
            var minutes = new MinutesContent("Returns sync", "We agreed the refund rule: money back within seven days.", ["Ravi", "Max"], [], ["Seven days"], [new("Update the policy page", "Ravi", null)], [], null);
            db.MeetingMinutes.Add(new MeetingMinutes { TenantId = tenant, BotRowId = bot.Id, ProjectId = o.Project, UserId = o.Owner.UserId, Title = "Returns sync minutes", Status = "ready",
                ContentProtected = secrets.Protect(JsonSerializer.Serialize(minutes, WebJson)), CreatedAt = now.AddHours(-1) });
            db.AgentSignals.Add(new AgentSignal { Id = signal, TenantId = tenant, ProjectId = o.Project, Source = AgentSourceKind.ProjectMailbox, SourceRef = "mail:returns-1", Title = "Annual plan returns",
                FromName = "Anita", ContentProtected = secrets.Protect("Anita asks what our refund rule is for annual plans; she wants her money back."), Length = 70, OccurredAt = now, CreatedAt = now });
            // Someone's private inbox is never indexed.
            db.AgentSignals.Add(new AgentSignal { TenantId = tenant, ProjectId = o.Project, Source = AgentSourceKind.PersonalMail, SourceRef = "mail:private-1", Title = "Private refund rule mail", OwnerUserId = o.Owner.UserId,
                ContentProtected = secrets.Protect("Private inbox: refund rule and money back, only for me."), Length = 50, OccurredAt = now, CreatedAt = now });
            db.SaveChanges();
            return 0;
        });
        await IndexForMeaning();
        var pieces = factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Where(c => c.TenantId == tenant && (c.SourceKind == "mail" || c.SourceKind == "minutes" || c.SourceKind == "transcript")).ToList());
        Assert.Equal(["mail", "minutes", "transcript"], pieces.Select(p => p.SourceKind).Distinct().Order().ToArray());
        Assert.All(pieces, p => Assert.Equal("", p.Text));   // encrypted at the source: the words are not copied into the index
        Assert.DoesNotContain(pieces, p => p.SourceKind == "mail" && p.SourceId != signal);   // no personal mail

        // Olivia (project owner, and sent the notetaker) and Max (on the project, in the call) may open them.
        var owner = await Knowledge(o.Owner, "What's our refund rule?");
        Assert.Contains(signal.ToString(), owner);
        Assert.Contains(bot.Id.ToString(), owner);
        Assert.Contains("Anita asks", owner);
        Assert.DoesNotContain("Private inbox", owner);
        var manager = await Knowledge(o.Manager, "What's our refund rule?");
        Assert.Contains(bot.Id.ToString(), manager);
        // Ravi works on nothing here: none of it, by search or by reading it directly.
        var outsider = await Knowledge(ravi, "What's our refund rule?");
        Assert.DoesNotContain(signal.ToString(), outsider);
        Assert.DoesNotContain(bot.Id.ToString(), outsider);
        Assert.DoesNotContain("Anita", outsider);
        Assert.DoesNotContain("seven days", outsider);
        var read = await RunTool(ravi, AiToolbox.ReadKnowledge, new { kind = "mail", id = signal, expected_version = "x" }, "Find and read the mail about the refund rule");
        Assert.DoesNotContain("Anita", read);
        // The guest cannot open any of it either.
        Assert.DoesNotContain(bot.Id.ToString(), await Knowledge(o.Guest, "What's our refund rule?"));

        // Reading a found source in full goes through the same check.
        var readIt = await RunTool(o.Owner, AiToolbox.ReadKnowledge, new { kind = "minutes", id = bot.Id, expected_version = "" }, "Find and read the minutes about the refund rule");
        Assert.Contains("Decision: Seven days", readIt);

        // The transcript is erased by the retention rules: it leaves the index; a person removed from the project loses the rest at once.
        factory.WithDb(db =>
        {
            db.AgentMeetingBots.IgnoreQueryFilters().Where(b => b.Id == bot.Id).ExecuteUpdate(u => u.SetProperty(b => b.TranscriptProtected, (string?)null));
            return 0;
        });
        await IndexForMeaning();
        Assert.False(factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Any(c => c.SourceKind == "transcript" && c.SourceId == bot.Id)));
        Assert.True((await o.Owner.Delete($"/api/v1/projects/{o.Project}/members/{o.Manager.UserId}")).Ok);
        Assert.DoesNotContain(signal.ToString(), await Knowledge(o.Manager, "What's our refund rule?"));
        Assert.DoesNotContain(bot.Id.ToString(), await Knowledge(o.Manager, "What's our refund rule?"));
    }

    [Fact]
    public async Task Indexing_is_incremental_bounded_and_skips_workspaces_that_switched_the_assistant_off()
    {
        var o = await Setup();
        var chat = S((await o.Manager.Post("/api/v1/chat/conversations/direct", new { userId = o.Owner.UserId })).Data!["id"]);
        for (var i = 0; i < 25; i++) await Say(o.Manager, chat, $"Message number {i} about the refund rule and the money back window for customers.");
        var chunks = () => factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Count(c => c.SourceKind == "chat" && c.TenantId == o.Owner.WorkspaceId));
        using (var scope = factory.Services.CreateScope())
        {
            var index = scope.ServiceProvider.GetRequiredService<AiSemanticIndex>();
            await index.IndexPendingAsync(70);   // 70 / 7 = 10 sources of each kind per pass
            Assert.InRange(chunks(), 1, 10 * AiSemanticIndex.MaxParts);
            Assert.True(factory.Embedder.MaxBatch <= AiSemanticIndex.EmbedBatch, $"a batch carried {factory.Embedder.MaxBatch} pieces");
        }
        var first = chunks();
        Assert.True(first < 25);
        for (var i = 0; i < 10; i++) if (await IndexForMeaning() == 0) break;
        Assert.Equal(25, chunks());
        var calls = factory.Embedder.Calls;
        Assert.Equal(0, await IndexForMeaning());   // nothing changed: nothing embedded again
        Assert.Equal(calls, factory.Embedder.Calls);

        // An edited message is embedded again; the others are not.
        var edited = factory.WithDb(db => db.ChatMessages.IgnoreQueryFilters().Where(m => m.ConversationId == Guid.Parse(chat)).OrderBy(m => m.CreatedAt).First().Id);
        factory.WithDb(db => db.ChatMessages.IgnoreQueryFilters().Where(m => m.Id == edited).ExecuteUpdate(u => u.SetProperty(m => m.Body, "Changed: the printer needs a new laptop cable and a computer restart.").SetProperty(m => m.EditedAt, DateTime.UtcNow)));
        Assert.Equal(1, await IndexForMeaning());
        Assert.Contains("printer", factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Single(c => c.SourceId == edited).Text));

        // The workspace switches the assistant off: what was taken from its chat leaves the index and is not taken again.
        factory.WithDb(db => db.Tenants.IgnoreQueryFilters().Where(t => t.Id == o.Owner.WorkspaceId).ExecuteUpdate(u => u.SetProperty(t => t.AiDisabled, true)));
        await IndexForMeaning();
        Assert.Equal(0, chunks());
        await Say(o.Manager, chat, "A new message about the refund rule and money back for annual customers.");
        await IndexForMeaning();
        Assert.Equal(0, chunks());
    }
}
