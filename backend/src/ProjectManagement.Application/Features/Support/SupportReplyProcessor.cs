using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Support;

/// <summary>
/// Finds WhatsApp chats waiting for the AI employee and answers each in its own workspace, acting as the person who connected the number
/// (so tickets it raises carry a real reporter and that person's permissions). A chat is claimed before it is answered, so two servers never
/// answer the same message; a failed answer is retried up to three times, then left for people in the inbox.
/// </summary>
public class SupportReplyProcessor(IServiceScopeFactory scopes, ILogger<SupportReplyProcessor> log)
{
    public async Task<int> ProcessAsync(CancellationToken ct = default)
    {
        List<(Guid Id, Guid Tenant)> due;
        using (var scan = scopes.CreateScope())
        {
            var db = scan.ServiceProvider.GetRequiredService<IAppDbContext>();
            // Cross-workspace scheduling reads only ids and the waiting flag; the chat itself is read in its own workspace below.
            due = (await db.SupportConversations.IgnoreQueryFilters().AsNoTracking()
                .Where(c => c.NeedsReply && c.Mode == "ai" && c.ReplyAttempts < 3)
                .OrderBy(c => c.LastMessageAt).Select(c => new { c.Id, c.TenantId }).Take(20).ToListAsync(ct))
                .Select(x => (x.Id, x.TenantId)).ToList();
        }
        var answered = 0;
        await Parallel.ForEachAsync(due, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct }, async (row, cancellation) =>
        {
            if (await AnswerAsync(row.Id, row.Tenant, cancellation)) Interlocked.Increment(ref answered);
        });
        return answered;
    }

    private async Task<bool> AnswerAsync(Guid id, Guid tenant, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var sp = scope.ServiceProvider;
        var context = sp.GetRequiredService<CurrentContext>();
        context.TenantId = tenant;
        var db = sp.GetRequiredService<IAppDbContext>();
        var claimed = await db.SupportConversations.Where(c => c.Id == id && c.NeedsReply)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.NeedsReply, false).SetProperty(c => c.ReplyAttempts, c => c.ReplyAttempts + 1), ct);
        if (claimed == 0) return false;
        var chat = await db.SupportConversations.AsNoTracking().Where(c => c.Id == id).Select(c => new { c.ChannelId, c.ReplyAttempts }).FirstAsync(ct);
        var connectedBy = await db.SupportChannels.AsNoTracking().Where(c => c.Id == chat.ChannelId).Select(c => (Guid?)c.ConnectedBy).FirstOrDefaultAsync(ct);
        var role = connectedBy is { } u ? await db.TenantMembers.AsNoTracking().Where(m => m.UserId == u).Select(m => (TenantRole?)m.Role).FirstOrDefaultAsync(ct) : null;
        context.UserId = role is null ? null : connectedBy;
        context.Role = role;
        context.WorkspaceType = await db.Tenants.AsNoTracking().Where(t => t.Id == tenant).Select(t => (WorkspaceType?)t.Type).FirstOrDefaultAsync(ct);
        try
        {
            await sp.GetRequiredService<SupportChannelService>().AutoReplyAsync(id, ct);
            return true;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning("WhatsApp chat {Chat}: the AI employee could not answer (attempt {Attempt}): {Reason}", id, chat.ReplyAttempts, e.Message);
            if (chat.ReplyAttempts < 3) await db.SupportConversations.Where(c => c.Id == id).ExecuteUpdateAsync(s => s.SetProperty(c => c.NeedsReply, true), ct);
            else await db.SupportConversations.Where(c => c.Id == id).ExecuteUpdateAsync(s => s.SetProperty(c => c.Status, "waiting"), ct);
            return false;
        }
    }
}
