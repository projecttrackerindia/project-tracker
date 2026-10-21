using System.Net;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Auth;

/// <summary>
/// The welcome letter, sent once when a new account is ready to use: after the address is verified, at once when verification is not required, or after a
/// first sign-up with Google, Microsoft, GitHub or Apple. Five first steps, each linking to its guide, and a signed note saying a person reads the replies.
/// People invited into an existing workspace get that workspace's own welcome instead.
/// </summary>
public class WelcomeMailer(IEmailSender email, IOptions<AppOptions> app, ILogger<WelcomeMailer> log)
{
    public async Task SendAsync(User user, CancellationToken ct)
    {
        try
        {
            var web = PublicUrls.Web(app.Value);
            string Enc(string s) => WebUtility.HtmlEncode(s);
            var steps = new (string Title, string Text, string Path)[]
            {
                ("Create your first project", "Add a project, a few tasks and due dates; the board, list and timeline views fill in by themselves.", "/docs/getting-started/"),
                ("Bring in what you already have", "Import tasks from Excel or Google Sheets in one go, with owners and dates.", "/docs/import-from-spreadsheet/"),
                ("Invite your team", "Add people by e-mail and choose what each one can see and change.", "/docs/getting-started/"),
                ("Connect Claude or ChatGPT", "Ask about your projects in plain words, with the assistant you already use.", "/docs/connect-claude-chatgpt/"),
                ("Secure your workspace", "Turn on passkeys or two-step sign-in in a minute.", "/docs/secure-your-workspace/"),
            };
            var list = string.Concat(steps.Select((s, i) =>
                $"<tr><td valign=\"top\" style=\"padding:0 12px 14px 0;width:26px\"><div style=\"width:26px;height:26px;border-radius:50%;background:#ede7fd;color:#6d28d9;font-weight:700;font-size:13px;line-height:26px;text-align:center\">{i + 1}</div></td>" +
                $"<td class=\"tx2\" style=\"padding:0 0 14px;font-size:14px;line-height:21px;color:#4a4268\"><a class=\"tx\" href=\"{Enc(web + s.Path)}\" style=\"color:#221a3a;font-weight:700;text-decoration:none\">{Enc(s.Title)}</a><br>{Enc(s.Text)}</td></tr>"));
            var body =
                "<p class=\"tx2\" style=\"margin:0 0 18px;font-size:15px;line-height:25px;color:#4a4268\">Your Project Tracker account is ready. The Free plan has no time limit, so take your time. Here is the quickest way to get value from it:</p>" +
                $"<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\" style=\"margin:0 0 10px\">{list}</table>" +
                "<p class=\"tx2\" style=\"margin:0 0 22px;font-size:15px;line-height:25px;color:#4a4268\">Your data is hosted in India, you can export it at any time, and you can delete your account whenever you choose. " +
                "If anything is unclear, just reply to this e-mail: a person reads every reply.</p>" +
                "<p class=\"tx2\" style=\"margin:0 0 22px;font-size:15px;line-height:25px;color:#4a4268\">Welcome aboard,<br><b class=\"tx\" style=\"color:#221a3a\">Prasanna Krishna Daddala</b><br>Founder, Project Tracker</p>";
            var html = EmailTemplates.Rich("Welcome to Project Tracker", $"Hi {Enc(user.DisplayName)},", body, "Open your workspace", web + "/",
                "You receive this once, because you created a Project Tracker account.", "Your account is ready: five first steps, each takes a few minutes.", EmailKind.Welcome);
            var text = $"Hi {user.DisplayName},\n\nYour Project Tracker account is ready. The Free plan has no time limit.\n\n" +
                string.Join("\n", steps.Select((s, i) => $"{i + 1}. {s.Title}: {s.Text} {web}{s.Path}")) +
                $"\n\nIf anything is unclear, reply to this e-mail: a person reads every reply.\n\nWelcome aboard,\nPrasanna Krishna Daddala\nFounder, Project Tracker\n{web}";
            await email.SendAsync(new EmailMessage(user.Email, "Welcome to Project Tracker — your first five steps", html, text, "welcome", ReplyTo: EmailTemplates.SupportEmail), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "The welcome e-mail could not be sent to user {User}", user.Id); }
    }
}
