using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Infrastructure.Services;

namespace ProjectManagement.Tests;

/// <summary>
/// <see cref="EmailSenderExtensions.TrySendAsync"/> (used after an action is already saved, so a bad mail server must not turn into a
/// failed or hung request) and the Resend HTTPS sender used when a host blocks outbound SMTP.
/// </summary>
public class EmailSendingTests
{
    private static EmailMessage Message() => new("someone@example.com", "Subject", "<p>html</p>", "text");

    [Fact]
    public async Task TrySendAsync_returns_true_when_the_sender_succeeds()
    {
        var ok = await new SucceedingSender().TrySendAsync(Message(), NullLogger.Instance);
        Assert.True(ok);
    }

    [Fact]
    public async Task TrySendAsync_returns_false_instead_of_throwing_when_the_sender_fails()
    {
        var ok = await new ThrowingSender().TrySendAsync(Message(), NullLogger.Instance);
        Assert.False(ok);
    }

    [Fact]
    public async Task TrySendAsync_gives_up_instead_of_hanging_when_the_sender_is_stuck()
    {
        // A server that never responds (e.g. a host silently dropping outbound SMTP) must not hold the caller open for minutes.
        var ok = await new HangingSender().TrySendAsync(Message(), NullLogger.Instance, timeout: TimeSpan.FromMilliseconds(50));
        Assert.False(ok);
    }

    [Fact]
    public async Task ResendEmailSender_throws_when_the_api_key_or_sender_address_is_missing()
    {
        var sender = new ResendEmailSender(new HttpClient(new NeverCalledHandler()), Options.Create(new ResendOptions { ApiKey = "", From = "" }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => sender.SendAsync(Message()));
    }

    [Fact]
    public async Task ResendEmailSender_posts_the_message_with_bearer_auth_and_succeeds_on_a_200()
    {
        HttpRequestMessage? captured = null;
        string? capturedBody = null;
        var handler = new StubHandler(async req =>
        {
            captured = req;
            capturedBody = await req.Content!.ReadAsStringAsync(); // the request's content is disposed once SendAsync returns, so read it here
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new { id = "abc" }) };
        });
        var sender = new ResendEmailSender(new HttpClient(handler), Options.Create(new ResendOptions { ApiKey = "re_test_key", From = "Project Tracker <no-reply@projecttracker.in>" }));

        await sender.SendAsync(Message());

        Assert.NotNull(captured);
        Assert.Equal(HttpMethod.Post, captured!.Method);
        Assert.Equal("https://api.resend.com/emails", captured.RequestUri!.ToString());
        Assert.Equal("Bearer", captured.Headers.Authorization!.Scheme);
        Assert.Equal("re_test_key", captured.Headers.Authorization.Parameter);
        var body = System.Text.Json.JsonSerializer.Deserialize<ResendRequestShape>(capturedBody!, new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        Assert.Equal("Project Tracker <no-reply@projecttracker.in>", body!.From);
        Assert.Equal(new[] { "someone@example.com" }, body.To);
        Assert.Equal("Subject", body.Subject);
    }

    [Fact]
    public async Task ResendEmailSender_throws_with_the_response_body_when_the_api_rejects_the_message()
    {
        var handler = new StubHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized)
        {
            Content = new StringContent("{\"message\":\"invalid API key\"}"),
        }));
        var sender = new ResendEmailSender(new HttpClient(handler), Options.Create(new ResendOptions { ApiKey = "bad", From = "no-reply@projecttracker.in" }));

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => sender.SendAsync(Message()));
        Assert.Contains("401", ex.Message);
        Assert.Contains("invalid API key", ex.Message);
    }

    private sealed record ResendRequestShape(string From, string[] To, string Subject, string? Html, string? Text);

    private sealed class SucceedingSender : IEmailSender
    {
        public string Name => "test";
        public Task SendAsync(EmailMessage message, CancellationToken ct = default) => Task.CompletedTask;
    }

    private sealed class ThrowingSender : IEmailSender
    {
        public string Name => "test";
        public Task SendAsync(EmailMessage message, CancellationToken ct = default) => throw new InvalidOperationException("mail server unreachable");
    }

    private sealed class HangingSender : IEmailSender
    {
        public string Name => "test";
        public Task SendAsync(EmailMessage message, CancellationToken ct = default) => Task.Delay(Timeout.InfiniteTimeSpan, ct);
    }

    private sealed class NeverCalledHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            throw new InvalidOperationException("The request should have failed validation before any HTTP call was made.");
    }

    private sealed class StubHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => respond(request);
    }
}
