using System.Net;
using MimeKit;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Mailbox;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>A forwarded message: "Fwd:" subject, the note, the original's sender, date and text below it, and its attachments.</summary>
public class MailForwardMessageTests
{
    private static MimeMessage Original()
    {
        var m = new MimeMessage { Subject = "Invoice 4412 for October", MessageId = "abc@vendor.test", Date = new DateTimeOffset(2026, 10, 20, 9, 30, 0, TimeSpan.FromHours(5.5)) };
        m.From.Add(new MailboxAddress("Vendor Billing", "billing@vendor.test"));
        m.To.Add(new MailboxAddress("Olivia", "olivia@example.test"));
        var b = new BodyBuilder { TextBody = "Please find the invoice attached. Due in 15 days." };
        b.Attachments.Add("invoice-4412.pdf", "%PDF-1.4 fake"u8.ToArray(), new ContentType("application", "pdf"));
        m.Body = b.ToMessageBody();
        return m;
    }

    [Fact]
    public void The_forward_carries_the_note_the_original_and_its_attachments()
    {
        var to = new InternetAddressList { new MailboxAddress("", "finance@example.test") };
        var fwd = MailboxService.ForwardMessage(Original(), new MailboxAddress("Olivia", "olivia@example.test"), to, new InternetAddressList(), "For payment this week.");
        Assert.Equal("Fwd: Invoice 4412 for October", fwd.Subject);
        Assert.Equal("finance@example.test", fwd.To.Mailboxes.Single().Address);
        var text = fwd.TextBody!;
        Assert.StartsWith("For payment this week.", text);
        Assert.Contains("---------- Forwarded message ---------", text);
        Assert.Contains("billing@vendor.test", text);
        Assert.Contains("Please find the invoice attached.", text);
        var attachment = Assert.Single(fwd.Attachments.OfType<MimePart>());
        Assert.Equal("invoice-4412.pdf", attachment.FileName);
        Assert.Contains("abc@vendor.test", fwd.References);
    }

    [Fact]
    public void A_subject_that_is_already_a_forward_is_kept_and_no_note_is_fine()
    {
        var original = Original(); original.Subject = "Fwd: Invoice";
        var fwd = MailboxService.ForwardMessage(original, new MailboxAddress("", "o@example.test"), new InternetAddressList { new MailboxAddress("", "f@example.test") }, new InternetAddressList(), null);
        Assert.Equal("Fwd: Invoice", fwd.Subject);
        Assert.StartsWith("---------- Forwarded message", fwd.TextBody);
    }
}

/// <summary>Deleting work and forwarding mail from the assistant: always a card, checked against the person's own rights.</summary>
public partial class AiWorkspaceTests
{
    [Fact]
    public async Task Deleting_work_is_a_card_that_moves_it_to_the_bin_and_respects_who_may_delete()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Old spike notes");
        var key = S(task["key"]); var id = S(task["id"]);

        var card = await Card(o.Owner, AiToolbox.DeleteWork, new { key, reason = "duplicate" }, $"Delete {key}");
        Assert.Equal("delete_work", card.Kind);
        Assert.Contains(key, S(card.Action["title"]));
        Assert.Equal(HttpStatusCode.OK, (await o.Owner.Get($"/api/v1/tasks/{id}")).Status);   // nothing happens before Confirm
        Assert.Equal("done", await Confirmed(o.Owner, card));
        Assert.Equal(HttpStatusCode.NotFound, (await o.Owner.Get($"/api/v1/tasks/{id}")).Status);

        // A guest cannot delete tasks: no card is offered.
        var other = await o.Owner.CreateTaskAsync(o.Project, "Keep me");
        await NoCard(o.Guest, AiToolbox.DeleteWork, new { key = S(other["key"]) }, $"Delete {S(other["key"])}");
        // And a key that is not real is said so, without a card.
        await NoCard(o.Owner, AiToolbox.DeleteWork, new { key = "ATLAS-999" }, "Delete ATLAS-999");
        Assert.Contains("no task", ToolResult(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Forwarding_needs_a_connected_mailbox_and_a_real_recipient()
    {
        var o = await Setup();
        // A name that is not a member is asked about, never guessed.
        await NoCard(o.Owner, AiWorkdayTools.MailForward, new { account = "google", message_id = "abc123", to = "finance" }, "Forward the invoice mail to finance");
        Assert.Contains("could not find", ToolResult(), StringComparison.OrdinalIgnoreCase);
        // A real address but no Gmail connected: nothing to forward from.
        await NoCard(o.Owner, AiWorkdayTools.MailForward, new { account = "google", message_id = "abc123", to = "finance@example.test" }, "Forward the invoice mail to finance@example.test");
    }
}
