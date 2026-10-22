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
    public async Task Company_mail_is_set_once_by_an_administrator()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olu Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Member, "Mo Member");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put("/api/v1/me/mailbox/company", new { provider = "rediffpro", domains = "fivestar.test" })).Status);
        Assert.Equal(422, (int)(await owner.Put("/api/v1/me/mailbox/company", new { provider = "rediffpro", domains = "not a domain" })).Status);
        Assert.Equal(422, (int)(await owner.Put("/api/v1/me/mailbox/company", new { provider = "custom", domains = "fivestar.test" })).Status);
        var saved = await owner.Put("/api/v1/me/mailbox/company", new { provider = "rediffpro", domains = "@FiveStar.test, fivestar.test" });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Single(saved.Data!["domains"]!.AsArray());
        var seen = (await member.Get("/api/v1/me/mailbox/accounts")).Data!;
        Assert.Equal("rediffpro", seen["company"]!["provider"]!.GetValue<string>());
        Assert.False(seen["canManageCompany"]!.GetValue<bool>());
        Assert.True((await owner.Put("/api/v1/me/mailbox/company", new { provider = "rediffpro", domains = "" })).Ok);
        Assert.Null((await member.Get("/api/v1/me/mailbox/accounts")).Data!["company"]);
    }

    [Fact]
    public async Task Company_mail_servers_are_checked_before_they_are_saved_or_tested()
    {
        var owner = await TestClient.RegisterAsync(factory, "Sam Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Member, "Mia Member");
        object Servers(string host, int port, string smtp = "smtp.example.test", int smtpPort = 465, string incoming = "pop") =>
            new { provider = "rediffpro", domains = "fivestar.test", incoming, incomingHost = host, incomingPort = port, smtpHost = smtp, smtpPort };
        async Task<string?> Field(object body) => (await owner.Put("/api/v1/me/mailbox/company", body)).Json?["errors"]?[0]?["field"]?.GetValue<string>();

        // An address instead of a name, a local name, a wrong port for the protocol and an unusual SMTP port are all refused before any connection.
        Assert.Equal("incomingHost", await Field(Servers("10.0.0.5", 995)));
        Assert.Equal("incomingHost", await Field(Servers("localhost", 995)));
        Assert.Equal("incomingPort", await Field(Servers("pop.example.test", 993)));
        Assert.Equal("incomingPort", await Field(Servers("imap.example.test", 995, incoming: "imap")));
        Assert.Equal("smtpPort", await Field(Servers("pop.example.test", 995, smtpPort: 25)));
        Assert.Equal("smtpHost", await Field(Servers("pop.example.test", 995, smtp: "127.0.0.1")));
        // Only owners and administrators may try servers with a password.
        var test = await member.Post("/api/v1/me/mailbox/company/test", new { settings = Servers("pop.example.test", 995), email = "mia@fivestar.test", password = "x" });
        Assert.Equal(HttpStatusCode.Forbidden, test.Status);
    }

    [Fact]
    public void Html_mail_is_reduced_to_readable_text()
    {
        var text = MailboxService.HtmlToText("<style>p{}</style><p>Hello&nbsp;team,</p><div>Ship <b>Friday</b></div><script>x()</script>");
        Assert.Equal("Hello team,\nShip Friday", text);
    }
}
