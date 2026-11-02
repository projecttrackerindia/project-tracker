using ProjectManagement.Application.Features.Ai;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
public sealed partial class AiMessageSendingTests
{
    [Fact]
    public Task A_confirmed_deployment_log_keeps_its_exact_interval() => Run(async (sender, _) =>
    {
        var project = await sender.CreateProjectAsync("Deployment");
        var task = await sender.CreateTaskAsync(project, "GO Collect setup", new { title = "GO Collect setup", priority = "High", assigneeId = sender.UserId });
        var key = task["key"]!.GetValue<string>();
        var date = DateOnly.FromDateTime(DateTime.UtcNow.AddMinutes(330)).AddDays(-1).ToString("yyyy-MM-dd");
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.LogTime, new { entries = new[] { new { key, minutes = 420, work_date = date, start_time = "09:30", end_time = "16:30" } } }));
        var reply = await Ask(sender, $"Log deployment work from 09:30 to 16:30 yesterday on {key}");
        Assert.Contains("09:30", reply["actions"]![0]!["summary"]!.GetValue<string>());
        Assert.True((await sender.Post(ConfirmUrl(reply))).Ok);
        var sheet = (await sender.Get($"/api/v1/time?from={date}&to={date}")).Data!;
        Assert.Equal(420, sheet["totalMinutes"]!.GetValue<int>());
        Assert.Equal(DateTimeOffset.Parse($"{date}T04:00:00Z"), DateTimeOffset.Parse(sheet["entries"]![0]!["startedAt"]!.GetValue<string>()));
        Assert.Equal(DateTimeOffset.Parse($"{date}T11:00:00Z"), DateTimeOffset.Parse(sheet["entries"]![0]!["endedAt"]!.GetValue<string>()));
    });
    [Fact]
    public Task A_time_only_follow_up_does_not_offer_portfolio_or_mail_tools() => Run((sender, _) =>
    {
        using var scope = factory.Services.CreateScope();
        var tools = scope.ServiceProvider.GetRequiredService<AiToolbox>().DefinitionsFor("log time in calendar and time also", true);
        Assert.Contains(tools, t => t.Name == AiToolbox.LogTime);
        Assert.Contains(tools, t => t.Name == AiToolbox.FindWork);
        Assert.DoesNotContain(tools, t => t.Name == AiToolbox.PortfolioBrief || t.Name == AiWorkdayTools.MailInbox);
        return Task.CompletedTask;
    });
}
