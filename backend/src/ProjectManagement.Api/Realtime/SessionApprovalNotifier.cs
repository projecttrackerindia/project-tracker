using Microsoft.AspNetCore.SignalR;
using ProjectManagement.Application.Features.Auth;

namespace ProjectManagement.Api.Realtime;

/// <summary>
/// "Single active session" in real time: a sign-in waiting for approval appears at once in every open app of the person; when it is answered (or times
/// out) the prompt closes everywhere; a session that was replaced is told why and signs out.
/// </summary>
public class SignalRSessionApprovalNotifier(IHubContext<ChatHub> hub) : ISessionApprovalNotifier
{
    public Task PromptAsync(Guid userId, SessionApprovalPendingDto prompt, CancellationToken ct = default) =>
        hub.Clients.Group(ChatGroups.Account(userId)).SendAsync("sessionApproval", prompt, ct);

    public Task ClosedAsync(Guid userId, Guid approvalId, string outcome, CancellationToken ct = default) =>
        hub.Clients.Group(ChatGroups.Account(userId)).SendAsync("sessionApprovalClosed", new { id = approvalId, outcome }, ct);

    public Task SignedOutAsync(Guid userId, IReadOnlyCollection<Guid> sessionIds, string message, CancellationToken ct = default) =>
        sessionIds.Count == 0 ? Task.CompletedTask
            : hub.Clients.Groups(sessionIds.Select(ChatGroups.Session).ToList()).SendAsync("sessionEnded", new { message }, ct);
}
