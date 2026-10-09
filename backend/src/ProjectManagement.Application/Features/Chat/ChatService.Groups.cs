using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Common;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Chat;

public partial class ChatService
{
    // ------------------------------------------------------------------ groups

    private async Task<string> NameOfAsync(Guid userId, CancellationToken ct) =>
        await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";

    private async Task<Conversation> GroupAsync(Guid id, CancellationToken ct)
    {
        var conv = await db.Conversations.FirstOrDefaultAsync(c => c.Id == id, ct) ?? throw new NotFoundException("This conversation was not found.", "CONVERSATION_NOT_FOUND");
        if (conv.Type != ConversationType.Group) throw new ValidationException("id", "Only a named group can be changed like this.");
        return conv;
    }

    private static void RequireGroupAdmin(ConversationMember mine)
    {
        if (mine.Role != ConversationRole.Admin) throw new ForbiddenException("Only a group admin can do this.", "GROUP_ADMIN_REQUIRED");
    }

    /// <summary>Adds a "Priya joined" style line to the thread.</summary>
    private ChatMessage AddSystemLine(Conversation conv, string text, DateTime now)
    {
        var line = new ChatMessage { ConversationId = conv.Id, Kind = ChatMessageKind.System, Body = text };
        db.ChatMessages.Add(line);
        conv.LastMessageAt = now; conv.LastMessageId = line.Id; conv.LastMessageSenderId = null; conv.LastMessageSnippet = Snippet(text);
        return line;
    }

    private async Task AnnounceAsync(Guid tenant, Conversation conv, ChatMessage line, IEnumerable<Guid> extraRecipients, CancellationToken ct)
    {
        var to = (await RecipientsAsync(tenant, conv.Id, ct)).Concat(extraRecipients).Distinct().ToList();
        var dto = (await ToDtosAsync([line], ct))[0];
        await PushAsync(tenant, to, ChatEvents.Message, new { conversationId = conv.Id, message = dto }, ct);
        await PushAsync(tenant, to, ChatEvents.Conversation, new { conversationId = conv.Id }, ct);
    }

    public async Task<ConversationDto> CreateGroupAsync(CreateGroupRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var name = CleanGroupName(req.Name);
        var others = (req.MemberIds ?? []).Where(id => id != me).Distinct().ToList();
        if (others.Count == 0) throw new ValidationException("memberIds", "Add at least one other person.");
        if (others.Count + 1 > MaxGroupMembers) throw new ValidationException("memberIds", $"A group can have at most {MaxGroupMembers} people.");
        if (await Eligible(tenant).CountAsync(m => others.Contains(m.UserId), ct) != others.Count)
            throw new ValidationException("memberIds", "Some of these people cannot be added to a group.");

        var now = clock.Now;
        var conv = new Conversation { Type = ConversationType.Group, Name = name, LastMessageAt = now };
        db.Conversations.Add(conv);
        db.ConversationMembers.Add(new ConversationMember { ConversationId = conv.Id, UserId = me, Role = ConversationRole.Admin, LastReadAt = now });
        foreach (var id in others) db.ConversationMembers.Add(new ConversationMember { ConversationId = conv.Id, UserId = id, LastReadAt = now });
        var line = AddSystemLine(conv, $"{await NameOfAsync(me, ct)} created the group “{name}”", now);
        await db.SaveChangesAsync(ct);

        await AnnounceAsync(tenant, conv, line, [], ct);
        return (await BuildAsync(me, [conv.Id], ct))[conv.Id];
    }

    public async Task<ConversationDto> RenameAsync(Guid id, RenameGroupRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var mine = await MembershipAsync(id, me, ct);
        var conv = await GroupAsync(id, ct);
        RequireGroupAdmin(mine);
        var name = CleanGroupName(req.Name);
        if (name == conv.Name) return (await BuildAsync(me, [id], ct))[id];

        conv.Name = name;
        var line = AddSystemLine(conv, $"{await NameOfAsync(me, ct)} renamed the group to “{name}”", clock.Now);
        await db.SaveChangesAsync(ct);
        await AnnounceAsync(tenant, conv, line, [], ct);
        return (await BuildAsync(me, [id], ct))[id];
    }

    public async Task<ConversationDto> AddMembersAsync(Guid id, AddMembersRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var mine = await MembershipAsync(id, me, ct);
        var conv = await GroupAsync(id, ct);
        RequireGroupAdmin(mine);

        var wanted = (req.UserIds ?? []).Distinct().ToList();
        var current = await db.ConversationMembers.Where(m => m.ConversationId == id).Select(m => m.UserId).ToListAsync(ct);
        var adding = wanted.Where(u => !current.Contains(u)).ToList();
        if (adding.Count == 0) throw new ValidationException("userIds", "Choose at least one person who is not in the group yet.");
        if (current.Count + adding.Count > MaxGroupMembers) throw new ValidationException("userIds", $"A group can have at most {MaxGroupMembers} people.");
        if (await Eligible(tenant).CountAsync(m => adding.Contains(m.UserId), ct) != adding.Count)
            throw new ValidationException("userIds", "Some of these people cannot be added to a group.");

        var now = clock.Now;
        foreach (var u in adding) db.ConversationMembers.Add(new ConversationMember { ConversationId = id, UserId = u, LastReadAt = now });
        var names = await db.Users.AsNoTracking().Where(u => adding.Contains(u.Id)).OrderBy(u => u.DisplayName).Select(u => u.DisplayName).ToListAsync(ct);
        var line = AddSystemLine(conv, $"{await NameOfAsync(me, ct)} added {string.Join(", ", names)}", now);
        await db.SaveChangesAsync(ct);
        await AnnounceAsync(tenant, conv, line, [], ct);
        return (await BuildAsync(me, [id], ct))[id];
    }

    /// <summary>Removes someone from a group, or lets a person leave it (removing yourself). Returns nothing: the caller may no longer see the group.</summary>
    public async Task RemoveMemberAsync(Guid id, Guid userId, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var mine = await MembershipAsync(id, me, ct);
        var conv = await GroupAsync(id, ct);
        if (userId != me) RequireGroupAdmin(mine);

        var target = await db.ConversationMembers.FirstOrDefaultAsync(m => m.ConversationId == id && m.UserId == userId, ct)
            ?? throw new NotFoundException("That person is not in this group.", "MEMBER_NOT_FOUND");
        var targetName = await NameOfAsync(userId, ct);
        db.ConversationMembers.Remove(target);
        await db.SaveChangesAsync(ct);

        var remaining = await db.ConversationMembers.Where(m => m.ConversationId == id).OrderBy(m => m.CreatedAt).ToListAsync(ct);
        if (remaining.Count == 0)
        {
            db.Conversations.Remove(conv);   // the last person left: nothing to keep
            await db.SaveChangesAsync(ct);
            await PushAsync(tenant, [userId], ChatEvents.Conversation, new { conversationId = id }, ct);
            return;
        }
        // A group is never left without someone who can manage it.
        if (!remaining.Any(m => m.Role == ConversationRole.Admin)) remaining[0].Role = ConversationRole.Admin;

        var line = AddSystemLine(conv, userId == me ? $"{targetName} left the group" : $"{await NameOfAsync(me, ct)} removed {targetName}", clock.Now);
        await db.SaveChangesAsync(ct);
        await AnnounceAsync(tenant, conv, line, [userId], ct);   // the removed person's list refreshes too
    }
}
