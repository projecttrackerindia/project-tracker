using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Envelope shape checks for private (end-to-end encrypted) chats: what the server accepts without being able to read it.</summary>
public class E2eEnvelopeTests
{
    private const string Good = """{"v":1,"iv":"aXZpdml2aXZpdml2","ct":"Y2lwaGVydGV4dA","from":"devA1234","keys":[{"d":"devB5678","k":"d3JhcHBlZA"}]}""";

    [Fact]
    public void A_well_formed_envelope_is_accepted() => Assert.Equal(Good, E2eEnvelope.Clean(Good));

    [Theory]
    [InlineData("")]
    [InlineData("hello in plain text")]
    [InlineData("""{"v":2,"iv":"a","ct":"b","keys":[{"d":"x"}]}""")]
    [InlineData("""{"v":1,"iv":"a","ct":"b","keys":[]}""")]
    [InlineData("""{"v":1,"ct":"b","keys":[{"d":"x"}]}""")]
    public void Anything_else_is_refused(string cipher) => Assert.Throws<ValidationException>(() => E2eEnvelope.Clean(cipher));

    [Fact]
    public void An_oversized_envelope_is_refused() =>
        Assert.Throws<ValidationException>(() => E2eEnvelope.Clean("{\"v\":1,\"iv\":\"a\",\"ct\":\"" + new string('a', E2eEnvelope.MaxChars) + "\",\"keys\":[{}]}"));
}

[Collection("api")]
public class PrivateChatTests(ApiFactory factory)
{
    private const string Envelope = """{"v":1,"iv":"aXZpdml2aXZpdml2","ct":"Y2lwaGVydGV4dA","from":"devA1234","keys":[{"d":"devB5678","k":"d3JhcHBlZA"}]}""";
    private const string Jwk = """{"kty":"EC","crv":"P-256","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"}""";

    private async Task<(TestClient A, TestClient B, TestClient Outsider, string Chat)> SetupAsync()
    {
        var a = await TestClient.RegisterAsync(factory, "Asha Sample");
        await a.CreateOrgAsync();
        await a.UpgradeAsync("BUSINESS");
        var b = await a.AddMemberAsync(factory, TenantRole.Member, "Bharat Sample");
        var outsider = await a.AddMemberAsync(factory, TenantRole.Member, "Chitra Sample");
        var chat = (await a.Post("/api/v1/chat/conversations/direct", new { userId = b.UserId })).Data!["id"]!.GetValue<string>();
        return (a, b, outsider, chat);
    }

    [Fact]
    public async Task A_private_chat_stores_ciphertext_only_and_refuses_plain_text()
    {
        var (a, b, _, chat) = await SetupAsync();
        var on = await a.Put($"/api/v1/chat/conversations/{chat}/private", new { enabled = true });
        Assert.True(on.Ok, on.ToString());
        Assert.True(on.Data!["isPrivate"]!.GetValue<bool>());

        // Plain text is refused once the chat is private.
        var plain = await a.Post($"/api/v1/chat/conversations/{chat}/messages", new { body = "the launch code is 1234" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, plain.Status);

        var sent = await a.Post($"/api/v1/chat/conversations/{chat}/messages", new { cipher = Envelope });
        Assert.Equal(HttpStatusCode.Created, sent.Status);
        Assert.Equal("", sent.Data!["body"]!.GetValue<string>());
        Assert.Equal(Envelope, sent.Data!["cipher"]!.GetValue<string>());

        // The other person gets the envelope; previews and notices never carry text.
        var page = (await b.Get($"/api/v1/chat/conversations/{chat}/messages")).Data!["items"]!.AsArray();
        Assert.Contains(page, m => m!["cipher"]?.GetValue<string>() == Envelope);
        var listed = (await b.Get("/api/v1/chat/conversations")).Data!.AsArray().First(c => c!["id"]!.GetValue<string>() == chat)!;
        Assert.Equal(ChatService.EncryptedSnippet, listed["lastMessage"]!["snippet"]!.GetValue<string>());
        Assert.True(factory.WithDb(db => db.ChatMessages.IgnoreQueryFilters().Where(m => m.ConversationId == Guid.Parse(chat) && m.Cipher != null).All(m => m.Body == "")));

        // Polls, files and the AI cannot work on ciphertext, so they are refused instead of leaking plain text.
        Assert.Equal(HttpStatusCode.Conflict, (await a.Post($"/api/v1/chat/conversations/{chat}/polls", new { question = "Lunch?", options = new[] { "Yes", "No" } })).Status);
    }

    [Fact]
    public async Task Envelopes_are_refused_outside_private_chats_and_project_chats_cannot_be_private()
    {
        var (a, _, _, chat) = await SetupAsync();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await a.Post($"/api/v1/chat/conversations/{chat}/messages", new { cipher = Envelope })).Status);
        var project = await a.CreateProjectAsync("Sample Orbit");
        var projectChat = (await a.Post($"/api/v1/chat/projects/{project}/open")).Data!["id"]!.GetValue<string>();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await a.Put($"/api/v1/chat/conversations/{projectChat}/private", new { enabled = true })).Status);
    }

    [Fact]
    public async Task Device_keys_are_public_only_and_visible_to_conversation_members_only()
    {
        var (a, b, outsider, chat) = await SetupAsync();
        // A JWK with a private part never gets stored.
        var leaked = await a.Put("/api/v1/chat/keys/devices", new { deviceId = "devA1234", publicKey = Jwk.TrimEnd('}') + ",\"d\":\"secret\"}" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, leaked.Status);
        Assert.True((await a.Put("/api/v1/chat/keys/devices", new { deviceId = "devA1234", publicKey = Jwk, label = "Sample laptop" })).Ok);
        Assert.True((await b.Put("/api/v1/chat/keys/devices", new { deviceId = "devB5678", publicKey = Jwk })).Ok);

        var keys = (await a.Get($"/api/v1/chat/conversations/{chat}/keys")).Data!.AsArray();
        Assert.Equal(2, keys.Count);
        Assert.DoesNotContain(keys, k => k!["publicKey"]!.GetValue<string>().Contains("\"d\""));
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Get($"/api/v1/chat/conversations/{chat}/keys")).Status);

        // A removed device is no longer encrypted for.
        Assert.Equal(HttpStatusCode.NoContent, (await b.Delete("/api/v1/chat/keys/devices/devB5678")).Status);
        Assert.Single((await a.Get($"/api/v1/chat/conversations/{chat}/keys")).Data!.AsArray());
    }

    [Fact]
    public async Task Device_keys_never_cross_workspaces()
    {
        var (a, _, _, _) = await SetupAsync();
        Assert.True((await a.Put("/api/v1/chat/keys/devices", new { deviceId = "devA1234", publicKey = Jwk })).Ok);
        var other = await TestClient.RegisterAsync(factory, "Dev Other");
        await other.CreateOrgAsync();
        await other.UpgradeAsync("BUSINESS");
        Assert.Empty((await other.Post("/api/v1/chat/keys/lookup", new { userIds = new[] { a.UserId } })).Data!.AsArray());
    }

    [Fact]
    public async Task The_recovery_copy_needs_strong_stretching()
    {
        var (a, _, _, _) = await SetupAsync();
        Assert.Equal(HttpStatusCode.NoContent, (await a.Get("/api/v1/chat/keys/backup")).Status);
        var weak = await a.Put("/api/v1/chat/keys/backup", new { salt = "c2FsdHNhbHRzYWx0c2FsdA", iterations = 1000, wrappedKey = new string('w', 60), publicKey = Jwk });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, weak.Status);
        var ok = await a.Put("/api/v1/chat/keys/backup", new { salt = "c2FsdHNhbHRzYWx0c2FsdA", iterations = 600_000, wrappedKey = new string('w', 60), publicKey = Jwk });
        Assert.True(ok.Ok, ok.ToString());
        Assert.Equal(600_000, (await a.Get("/api/v1/chat/keys/backup")).Data!["iterations"]!.GetValue<int>());
    }

    [Fact]
    public async Task A_call_in_a_private_chat_is_end_to_end_encrypted_and_has_no_notetaker()
    {
        var (a, b, _, chat) = await SetupAsync();
        Assert.True((await a.Put($"/api/v1/chat/conversations/{chat}/private", new { enabled = true })).Ok);
        var started = await a.Post("/api/v1/calls", new { conversationId = chat, keyCipher = Envelope });
        Assert.Equal(HttpStatusCode.Created, started.Status);
        Assert.True(started.Data!["isPrivate"]!.GetValue<bool>());
        var id = started.Data!["id"]!.GetValue<string>();
        var join = (await b.Post($"/api/v1/calls/{id}/join")).Data!;
        Assert.True(join["e2ee"]!.GetValue<bool>());
        Assert.Equal(Envelope, join["keyCipher"]!.GetValue<string>());
        // Only the host may share the key again.
        Assert.Equal(HttpStatusCode.Forbidden, (await b.Put($"/api/v1/calls/{id}/key", new { keyCipher = Envelope })).Status);
        Assert.True((await a.Put($"/api/v1/calls/{id}/key", new { keyCipher = Envelope })).Ok);

        var project = await a.CreateProjectAsync("Sample Quiet");
        var withAgent = await a.Post("/api/v1/calls", new { projectId = project, @private = true, agent = true });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, withAgent.Status);
    }
}
