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
    public void Html_mail_is_reduced_to_readable_text()
    {
        var text = MailboxService.HtmlToText("<style>p{}</style><p>Hello&nbsp;team,</p><div>Ship <b>Friday</b></div><script>x()</script>");
        Assert.Equal("Hello team,\nShip Friday", text);
    }
}
