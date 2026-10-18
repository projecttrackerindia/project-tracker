using System.Globalization;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>A message from a person's own mailbox that mentions one of their projects (for the project agent, which they opted in to).</summary>
public record AgentMailDto(string Id, string Subject, string Sender, DateTimeOffset? ReceivedAt, string Body);

public partial class PersonalInboxService
{
    /// <summary>
    /// Mail received since <paramref name="sinceUtc"/> that mentions any of <paramref name="terms"/> (project names and keys), with its plain-text
    /// body. Only the signed-in person's own mailbox (the current context), only after they opted in to the project agent - the caller checks that.
    /// </summary>
    public async Task<IReadOnlyList<AgentMailDto>> SearchForAgentAsync(string provider, DateTime sinceUtc, IReadOnlyList<string> terms, int max, CancellationToken ct)
    {
        var clean = terms.Select(t => new string(t.Where(c => !char.IsControl(c) && c != '"' && c != '\'' && c != '\\').ToArray()).Trim())
            .Where(t => t.Length is >= 3 and <= 60).Distinct(StringComparer.OrdinalIgnoreCase).Take(10).ToList();
        if (clean.Count == 0) return [];
        max = Math.Clamp(max, 1, 25);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(45));
        try
        {
            var grant = await GrantAsync(provider, deadline.Token);
            var found = new List<AgentMailDto>();
            if (provider == "google")
            {
                var q = $"after:{new DateTimeOffset(DateTime.SpecifyKind(sinceUtc, DateTimeKind.Utc)).ToUnixTimeSeconds()} -in:chats ({string.Join(" OR ", clean.Select(t => $"\"{t}\""))})";
                using var page = await ReadAsync(grant, $"{Gmail}/messages?maxResults={max}&q={Uri.EscapeDataString(q)}", deadline.Token);
                var messages = page.RootElement.TryGetProperty("messages", out _) ? Array(page.RootElement, "messages", 100) : [];
                foreach (var m in messages.Take(max))
                {
                    using var detail = await ReadAsync(grant, $"{Gmail}/messages/{Id(Text(m, "id"), provider)}?format=full", deadline.Token, 1048576);
                    var mail = Google(detail.RootElement, true);
                    found.Add(new AgentMailDto(mail.Id, mail.Subject, mail.Sender, mail.ReceivedAt, mail.Body ?? ""));
                }
            }
            else
            {
                var seen = new HashSet<string>();
                foreach (var term in clean)
                {
                    using var page = await ReadAsync(grant, $"{Graph}/messages?$top=10&$search={Uri.EscapeDataString($"\"{term}\"")}&$select={Metadata},body", deadline.Token, 1048576);
                    foreach (var m in Array(page.RootElement, "value", 10))
                    {
                        var mail = Outlook(m, true);
                        if (mail.ReceivedAt is { } at && at.UtcDateTime < sinceUtc) continue;
                        if (!seen.Add(mail.Id)) continue;
                        found.Add(new AgentMailDto(mail.Id, mail.Subject, mail.Sender, mail.ReceivedAt, mail.Body ?? ""));
                        if (found.Count >= max) break;
                    }
                    if (found.Count >= max) break;
                }
            }
            await RecheckAsync(grant, deadline.Token);
            return found;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new AppException(504, "INBOX_TIMEOUT", "The mailbox took too long to respond."); }
        catch (HttpRequestException) { throw new AppException(502, "INBOX_PROVIDER_ERROR", "The mailbox could not be reached."); }
    }
}
