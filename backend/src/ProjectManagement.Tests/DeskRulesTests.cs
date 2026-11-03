using System.Security.Cryptography;
using System.Text;
using ProjectManagement.Application.Features.Desk;
using ProjectManagement.Application.Features.Support;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Tests;

/// <summary>The Desk's pure decisions: webhook signatures, routing, escalation, retries and the confidence threshold.</summary>
public class DeskRulesTests
{
    private static readonly Guid Asha = Guid.NewGuid(), Ravi = Guid.NewGuid(), Meena = Guid.NewGuid(), Kiran = Guid.NewGuid();

    private static DeskCandidate Eng(Guid id, string name, string status = "available", string skills = "", string dept = "IT", int active = 0, int max = 5,
        int? start = null, int? end = null, bool onCall = false) =>
        new(id, name, status, DeskRules.SplitSkills(skills), dept, active, max, start, end, onCall);

    private static DeskRouteRequest Req(Priority p = Priority.Medium, string dept = "", string skills = "", int now = 600, params Guid[] exclude) =>
        new(p, dept, DeskRules.SplitSkills(skills), now, exclude);

    [Fact]
    public void A_signature_must_be_the_app_secrets_hmac_of_the_exact_body()
    {
        const string secret = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
        var body = Encoding.UTF8.GetBytes("{\"entry\":[]}");
        var good = "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), body)).ToLowerInvariant();
        Assert.True(SupportChannelService.SignatureValid(secret, body, good));
        Assert.True(SupportChannelService.SignatureValid(secret, body, good.ToUpperInvariant().Replace("SHA256=", "sha256=")));
        Assert.False(SupportChannelService.SignatureValid(secret, Encoding.UTF8.GetBytes("{\"entry\":[1]}"), good));   // tampered body
        Assert.False(SupportChannelService.SignatureValid("another-secret-another-secret-00", body, good));
        Assert.False(SupportChannelService.SignatureValid(secret, body, null));
        Assert.False(SupportChannelService.SignatureValid(secret, body, good[7..]));                                     // no "sha256=" prefix
        Assert.False(SupportChannelService.SignatureValid(secret, body, "sha256=" + new string('0', 64)));
    }

    [Fact]
    public void Routing_offers_available_people_in_shift_and_under_their_limit_best_skills_and_room_first()
    {
        var ranked = DeskRules.Rank(Req(skills: "access"), [
            Eng(Asha, "Asha", skills: "access,network", active: 3),
            Eng(Ravi, "Ravi", skills: "access", active: 0),
            Eng(Meena, "Meena", status: "offline", skills: "access"),
            Eng(Kiran, "Kiran", skills: "access", onCall: true),
        ]);
        Assert.Equal(new[] { Ravi, Asha }, ranked.Select(r => r.UserId));
        Assert.True(ranked[0].Score > ranked[1].Score);
        Assert.Contains("skills access", ranked[0].Reason);

        // At the limit, outside the shift, or excluded (already tried): not offered.
        Assert.Empty(DeskRules.Rank(Req(), [Eng(Asha, "Asha", active: 5, max: 5)]));
        Assert.Empty(DeskRules.Rank(Req(now: 8 * 60), [Eng(Asha, "Asha", start: 9 * 60, end: 18 * 60)]));
        Assert.Single(DeskRules.Rank(Req(now: 23 * 60), [Eng(Asha, "Asha", start: 22 * 60, end: 6 * 60)]));   // a night shift past midnight
        Assert.Empty(DeskRules.Rank(Req(exclude: new[] { Asha }), [Eng(Asha, "Asha")]));
    }

    [Fact]
    public void The_tickets_department_comes_first_and_a_critical_ticket_may_go_to_someone_busy()
    {
        var people = new[] { Eng(Asha, "Asha", dept: "Finance operations", active: 4), Eng(Ravi, "Ravi", dept: "IT") };
        Assert.Equal(Asha, DeskRules.Rank(Req(dept: "finance operations"), people)[0].UserId);
        Assert.Equal(Ravi, DeskRules.Rank(Req(dept: "Facilities"), people)[0].UserId);   // nobody in that department: everyone qualifies

        var busy = new[] { Eng(Asha, "Asha", status: "busy") };
        Assert.Empty(DeskRules.Rank(Req(Priority.High), busy));
        Assert.Single(DeskRules.Rank(Req(Priority.Critical), busy));
    }

    [Fact]
    public void An_unaccepted_offer_moves_on_then_goes_to_the_supervisor_once()
    {
        var now = new DateTime(2026, 11, 3, 10, 0, 0, DateTimeKind.Utc);
        Assert.Equal(DeskEscalationStep.None, DeskRules.Escalation(now, now.AddMinutes(1), null, 0, 2, null));          // still inside the window
        Assert.Equal(DeskEscalationStep.None, DeskRules.Escalation(now, now.AddMinutes(-1), now.AddMinutes(-5), 0, 2, null)); // accepted
        Assert.Equal(DeskEscalationStep.None, DeskRules.Escalation(now, null, null, 0, 2, null));                       // a supervisor override has no window
        Assert.Equal(DeskEscalationStep.Reassign, DeskRules.Escalation(now, now.AddMinutes(-1), null, 0, 2, null));
        Assert.Equal(DeskEscalationStep.Reassign, DeskRules.Escalation(now, now.AddMinutes(-1), null, 1, 2, null));
        Assert.Equal(DeskEscalationStep.Supervisor, DeskRules.Escalation(now, now.AddMinutes(-1), null, 2, 2, null));
        Assert.Equal(DeskEscalationStep.None, DeskRules.Escalation(now, now.AddMinutes(-1), null, 2, 2, now.AddMinutes(-1))); // told once
    }

    [Fact]
    public void Failed_inbound_messages_back_off_then_become_dead_letters()
    {
        var now = new DateTime(2026, 11, 3, 10, 0, 0, DateTimeKind.Utc);
        Assert.Equal(now.AddSeconds(30), DeskRules.NextAttempt(1, now));
        Assert.Equal(now.AddSeconds(60), DeskRules.NextAttempt(2, now));
        Assert.Equal(now.AddMinutes(4), DeskRules.NextAttempt(4, now));
        Assert.Null(DeskRules.NextAttempt(DeskRules.MaxAttempts, now));
    }

    [Fact]
    public void Uncertain_ai_decisions_wait_for_a_person_and_rules_are_only_sure_of_clear_requests()
    {
        Assert.True(DeskRules.NeedsReview(69, 70));
        Assert.False(DeskRules.NeedsReview(70, 70));
        var login = DeskClassifier.Heuristic("I cannot login, my password reset OTP never arrives");
        Assert.Equal("Login and access", login.Category);
        Assert.Equal(Priority.High, login.Priority);
        Assert.False(DeskRules.NeedsReview(login.Confidence, 70));
        var vague = DeskClassifier.Heuristic("hello, please call me back");
        Assert.Equal("General", vague.Category);
        Assert.True(DeskRules.NeedsReview(vague.Confidence, 70));
        Assert.Equal(Priority.Critical, DeskClassifier.Heuristic("Production down for all users").Priority);

        var parsed = DeskClassifier.Parse("Sure: {\"category\":\"Payments\",\"priority\":\"high\",\"department\":\"Finance\",\"skills\":[\"upi\"],\"confidence\":0.92,\"summary\":\"UPI debit not credited\"}");
        Assert.NotNull(parsed);
        Assert.Equal(92, parsed!.Confidence);
        Assert.Equal(Priority.High, parsed.Priority);
        Assert.Null(DeskClassifier.Parse("I could not decide"));
    }
}
