using System.Net;
using ProjectManagement.Application.Features.Mailbox;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Mailbox: accounts, validation of what may be connected or sent, and the mail agent's availability.</summary>
[Collection("api")]
public class MailboxTests(ApiFactory factory)
{
    [Fact]
    public async Task Accounts_offer_only_known_providers_and_reject_bad_input()
    {
        var me = await TestClient.RegisterAsync(factory, "Mona Mail");
        await me.CreateOrgAsync();
        var accounts = await me.Get("/api/v1/me/mailbox/accounts");
        Assert.True(accounts.Ok, accounts.ToString());
        Assert.Empty(accounts.Data!["imap"]!.AsArray());
        Assert.Contains(accounts.Data!["presets"]!.AsArray(), p => p!["id"]!.GetValue<string>() == "rediff");

        // A host can never be supplied, only a preset.
        Assert.Equal(422, (int)(await me.Post("/api/v1/me/mailbox/accounts/imap", new { provider = "custom", email = "a@b.com", password = "x" })).Status);
        Assert.Equal(422, (int)(await me.Post("/api/v1/me/mailbox/accounts/imap", new { provider = "rediff", email = "not-an-email", password = "x" })).Status);
        Assert.Equal(422, (int)(await me.Post("/api/v1/me/mailbox/accounts/imap", new { provider = "rediff", email = "mona@rediffmail.com", password = "" })).Status);

        Assert.Equal(422, (int)(await me.Get("/api/v1/me/mailbox/messages?account=imap:nope")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await me.Get($"/api/v1/me/mailbox/messages?account=imap:{Guid.NewGuid()}")).Status);
        Assert.Equal(422, (int)(await me.Get("/api/v1/me/mailbox/messages?account=google&folder=spam")).Status);
        Assert.Equal(422, (int)(await me.Post("/api/v1/me/mailbox/send", new { account = "google", body = "Hi", to = "x@y.com", confirmed = false })).Status);
        Assert.Equal(422, (int)(await me.Post("/api/v1/me/mailbox/agent/compose", new { draft = "", mode = "improve" })).Status);
        var options = await me.Get("/api/v1/me/mailbox/agent/options");
        Assert.True(options.Ok, options.ToString());
    }

    [Fact]
    public void Html_mail_is_reduced_to_readable_text()
    {
        var text = MailboxService.HtmlToText("<style>p{}</style><p>Hello&nbsp;team,</p><div>Ship <b>Friday</b></div><script>x()</script>");
        Assert.Equal("Hello team,\nShip Friday", text);
    }
}
