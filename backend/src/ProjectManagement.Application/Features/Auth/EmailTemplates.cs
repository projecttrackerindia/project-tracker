using System.Net;

namespace ProjectManagement.Application.Features.Auth;

/// <summary>What the message is about: it sets the small label and the accent color above the headline.</summary>
public enum EmailKind { Update, Security, Invitation, Reminder, Welcome, Billing }

/// <summary>What the task-change e-mail shows (see <see cref="EmailTemplates.Change"/>). Plain text: the template encodes it.</summary>
public record ChangeEmail(string Project, string Accent, string Headline, string Subtitle, string? Before, string? After, string? Delta,
    IReadOnlyList<(string Label, string Value)> Facts, string OpenUrl, string? UndoUrl, string? DigestUrl, string DigestTime, string? SettingsUrl, string? UnsubscribeUrl,
    string Reason, string Preheader, string? Workspace = null, string? AfterTint = null);

/// <summary>
/// The one look every e-mail shares: a dark gradient header with the product mark, a clean card with the message, one bold button and the link in words
/// for programs that block buttons. Table layout and inline styles because mail programs ignore almost everything else; the button is a real
/// (VML) button in Outlook, which would otherwise drop its padding; the header falls back to a solid color where gradients are not drawn; and a dark
/// color scheme is provided for the programs that honor it (Apple Mail, Outlook.com, Gmail's apps invert on their own).
/// </summary>
public static class EmailTemplates
{
    private static string Enc(string s) => WebUtility.HtmlEncode(s);

    /// <summary>Where people write with any question (App:SupportEmail): shown in every e-mail's footer and in messages that say "contact support".</summary>
    public static string SupportEmail { get; set; } = "support@projecttracker.in";

    private static (string Label, string Accent) Look(EmailKind k) => k switch
    {
        EmailKind.Security => ("SECURITY", "#fbbf24"),
        EmailKind.Invitation => ("INVITATION", "#22d3ee"),
        EmailKind.Reminder => ("REMINDER", "#f472b6"),
        EmailKind.Welcome => ("WELCOME", "#34d399"),
        EmailKind.Billing => ("BILLING", "#fb923c"),
        _ => ("UPDATE", "#c4b5fd"),
    };

    public static string Wrap(string title, string greeting, string body, string cta, string link, string? footer = null, string? preheader = null, string? unsubscribeUrl = null,
        EmailKind kind = EmailKind.Update, IReadOnlyList<(string Label, string Value)>? details = null) =>
        Render(title, greeting, $"<p class=\"tx2\" style=\"margin:0 0 22px;font-size:15px;line-height:25px;color:#4a4268\">{Enc(body)}</p>", cta, link, footer, preheader, unsubscribeUrl, kind, details);

    /// <summary>A message whose body the caller has already built as HTML (every value in it encoded by the caller).</summary>
    public static string Rich(string title, string greeting, string bodyHtml, string cta, string link, string? footer = null, string? preheader = null, EmailKind kind = EmailKind.Update,
        string? unsubscribeUrl = null) =>
        Render(title, greeting, bodyHtml, cta, link, footer, preheader, unsubscribeUrl, kind, null);

    /// <summary>Several short updates in one message, each with its own link: used instead of many separate e-mails.</summary>
    public static string Digest(string title, string greeting, IReadOnlyList<(string Title, string? Body, string Link)> items, string cta, string link, string? footer, string? preheader, string? unsubscribeUrl)
    {
        var rows = string.Concat(items.Take(15).Select(i =>
            $"<tr><td class=\"line\" style=\"padding:12px 0;border-top:1px solid #efeaf9\"><a class=\"tx\" href=\"{Enc(i.Link)}\" style=\"color:#221a3a;font-weight:600;text-decoration:none;font-size:15px\">{Enc(i.Title)}</a>" +
            $"{(string.IsNullOrWhiteSpace(i.Body) || i.Body == i.Title ? "" : $"<div class=\"tx2\" style=\"color:#6a6288;font-size:13px;line-height:20px;padding-top:2px\">{Enc(i.Body.Length > 140 ? i.Body[..140] + "…" : i.Body)}</div>")}</td></tr>"));
        var more = items.Count > 15 ? $"<p class=\"tx2\" style=\"margin:0 0 18px;font-size:13px;color:#6a6288\">and {items.Count - 15} more.</p>" : "";
        return Render(title, greeting, $"<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 18px\">{rows}</table>{more}", cta, link, footer, preheader, unsubscribeUrl, EmailKind.Update, null);
    }

    private static string Render(string title, string greeting, string bodyHtml, string cta, string link, string? footer, string? preheader, string? unsubscribeUrl, EmailKind kind,
        IReadOnlyList<(string Label, string Value)>? details)
    {
        var (label, accent) = Look(kind);
        // The product's logo, served from the site itself (a PNG: mail programs do not show SVG). Where images are blocked, the purple tile with a
        // tick is what people see instead, so the header never looks broken.
        string origin;
        try { origin = new Uri(link).GetLeftPart(UriPartial.Authority); } catch (UriFormatException) { origin = ""; }
        var host = origin.Replace("https://", "").Replace("http://", "");
        var tile = "width:34px;height:34px;border-radius:10px;background:#7c3aed;background-image:linear-gradient(135deg,#8b5cf6,#c084fc);color:#ffffff;font-size:17px;font-weight:700;line-height:34px";
        var mark = origin.Length > 0 && origin.StartsWith("https://", StringComparison.Ordinal)
            ? $"<td width=\"34\" height=\"34\" align=\"center\" valign=\"middle\" bgcolor=\"#7c3aed\" style=\"{tile}\"><img src=\"{Enc(origin)}/email/logo.png\" width=\"34\" height=\"34\" alt=\"&#10003;\" style=\"display:block;width:34px;height:34px;border:0;border-radius:10px;color:#ffffff;font-size:17px;line-height:34px;text-align:center\"></td>"
            : $"<td width=\"34\" height=\"34\" align=\"center\" valign=\"middle\" bgcolor=\"#7c3aed\" style=\"{tile}\">&#10003;</td>";
        var hidden = preheader is null ? "" : $"<div style=\"display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px\">{Enc(preheader)}&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;</div>";
        var facts = details is { Count: > 0 }
            ? "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" class=\"panel\" style=\"margin:0 0 22px;background:#f7f4ff;border:1px solid #e7e1f7;border-radius:12px\">" +
              string.Concat(details.Select((d, i) => $"<tr><td class=\"tx2\" style=\"padding:{(i == 0 ? 14 : 4)}px 16px {(i == details.Count - 1 ? 14 : 4)}px;font-size:13px;line-height:20px;color:#6a6288\"><span style=\"display:inline-block;width:92px;letter-spacing:.4px;text-transform:uppercase;font-size:11px\">{Enc(d.Label)}</span><span class=\"tx\" style=\"color:#221a3a;font-weight:600\">{Enc(d.Value)}</span></td></tr>")) + "</table>"
            : "";
        var width = Math.Clamp(64 + cta.Length * 9, 168, 340);
        var button =
            $"<!--[if mso]><v:roundrect xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:w=\"urn:schemas-microsoft-com:office:word\" href=\"{Enc(link)}\" style=\"height:48px;v-text-anchor:middle;width:{width}px\" arcsize=\"25%\" stroke=\"f\" fillcolor=\"#7c3aed\"><w:anchorlock/><center style=\"color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:bold\">{Enc(cta)}</center></v:roundrect><![endif]-->" +
            $"<!--[if !mso]><!--><a href=\"{Enc(link)}\" style=\"display:inline-block;background:#7c3aed;background-image:linear-gradient(135deg,#6d28d9,#a855f7);color:#ffffff;padding:14px 30px;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px;line-height:20px;letter-spacing:.1px;box-shadow:0 8px 20px rgba(124,58,237,.35)\">{Enc(cta)}</a><!--<![endif]-->";
        var foot = footer is null ? "" : $"<p class=\"tx3\" style=\"margin:0 0 8px;font-size:12px;line-height:19px;color:#8a82a6\">{Enc(footer)}</p>";
        var stop = unsubscribeUrl is null ? "" : $"<p class=\"tx3\" style=\"margin:0 0 8px;font-size:12px;line-height:19px;color:#8a82a6\"><a href=\"{Enc(unsubscribeUrl)}\" style=\"color:#8a82a6;text-decoration:underline\">Stop emails like this</a></p>";
        var links = origin.Length == 0 ? "" :
            $"<p class=\"tx3\" style=\"margin:0 0 8px;font-size:12px;line-height:19px;color:#8a82a6\"><a href=\"{Enc(origin)}\" class=\"lnk\" style=\"color:#7c3aed;text-decoration:none\">Open Project Tracker</a> &nbsp;&middot;&nbsp; <a href=\"{Enc(origin)}/account/notifications\" class=\"lnk\" style=\"color:#7c3aed;text-decoration:none\">Notification settings</a> &nbsp;&middot;&nbsp; <a href=\"{Enc(origin)}/security\" class=\"lnk\" style=\"color:#7c3aed;text-decoration:none\">Security</a></p>";
        var help = SupportEmail.Contains('@')
            ? $"<p class=\"tx3\" style=\"margin:0 0 8px;font-size:12px;line-height:19px;color:#8a82a6\">Questions? Write to <a href=\"mailto:{Enc(SupportEmail)}\" class=\"lnk\" style=\"color:#7c3aed;text-decoration:none\">{Enc(SupportEmail)}</a></p>"
            : "";

        return $$$"""
            <!doctype html><html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>{{{Enc(title)}}}</title>
            <!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
            <style>
              body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
              table,td{mso-table-lspace:0;mso-table-rspace:0}
              @media (max-width:520px){.wrap{padding:14px 8px!important}.pad{padding-left:20px!important;padding-right:20px!important}.h1{font-size:23px!important;line-height:30px!important}}
              @media (prefers-color-scheme:dark){
                .bg{background:#0b0816!important}
                .card{background:#15102a!important;border-color:#2b2250!important}
                .tx{color:#f1edff!important}.tx2{color:#c2b9e6!important}.tx3{color:#9d93c4!important}
                .panel{background:#1e1840!important;border-color:#31285c!important}
                .mono{background:#1e1840!important;border-color:#31285c!important;color:#c4b5fd!important}
                .line{border-top-color:#2b2250!important}
                .lnk{color:#c4b5fd!important}
              }
              [data-ogsc] .bg{background:#0b0816!important}[data-ogsc] .card{background:#15102a!important}[data-ogsc] .tx{color:#f1edff!important}[data-ogsc] .tx2{color:#c2b9e6!important}
            </style></head>
            <body class="bg" style="margin:0;padding:0;background:#eef0fb;word-spacing:normal">{{{hidden}}}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:#eef0fb"><tr><td align="center" class="wrap" style="padding:32px 14px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
                <tr><td bgcolor="#2a1560" style="background:#2a1560;background-image:linear-gradient(135deg,#150c33 0%,#2f1a70 55%,#6d28d9 100%);border-radius:20px 20px 0 0;padding:0">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td height="4" style="height:4px;line-height:4px;font-size:0;background:{{{accent}}};border-radius:20px 20px 0 0">&nbsp;</td></tr></table>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="pad" style="padding:26px 32px 30px;font-family:Inter,'Segoe UI',Roboto,Arial,sans-serif">
                    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                      {{{mark}}}
                      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#ffffff;letter-spacing:.2px">Project Tracker<div style="font-size:11px;font-weight:500;color:#c9bdf5;letter-spacing:.3px;padding-top:1px">projecttracker.in</div></td>
                    </tr></table>
                    <p style="margin:26px 0 8px;font-size:11px;line-height:16px;font-weight:700;letter-spacing:2.2px;color:{{{accent}}}">{{{label}}}</p>
                    <h1 class="h1" style="margin:0;font-size:27px;line-height:34px;font-weight:800;letter-spacing:-.4px;color:#ffffff">{{{Enc(title)}}}</h1>
                  </td></tr></table>
                </td></tr>
                <tr><td class="card pad" style="background:#ffffff;border:1px solid #e6e0f7;border-top:0;border-radius:0 0 20px 20px;padding:30px 32px 30px;font-family:Inter,'Segoe UI',Roboto,Arial,sans-serif;color:#221a3a">
                  <p class="tx" style="margin:0 0 12px;font-size:16px;line-height:25px;color:#221a3a">{{{greeting}}}</p>
                  {{{bodyHtml}}}
                  {{{facts}}}
                  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px"><tr><td>{{{button}}}</td></tr></table>
                  <p class="tx3" style="margin:0 0 8px;font-size:12px;line-height:18px;color:#8a82a6">Button not working? Paste this link into your browser:</p>
                  <p class="mono" style="margin:0;padding:10px 12px;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:18px;color:#6d28d9;background:#f7f4ff;border:1px solid #e7e1f7;border-radius:10px;word-break:break-all"><a class="lnk" href="{{{Enc(link)}}}" style="color:#6d28d9;text-decoration:none">{{{Enc(link)}}}</a></p>
                </td></tr>
                <tr><td class="pad" style="padding:20px 32px 0;font-family:Inter,'Segoe UI',Roboto,Arial,sans-serif;text-align:center">{{{foot}}}{{{stop}}}{{{links}}}{{{help}}}
                  <p class="tx3" style="margin:6px 0 0;font-size:11px;line-height:17px;color:#a59ec3">Sent by Project Tracker{{{(host.Length > 0 ? " · " + Enc(host) : "")}}} · Hyderabad, India</p></td></tr>
              </table>
            </td></tr></table></body></html>
            """;
    }

    /// <summary>
    /// The task-change e-mail (design plansheet8/06): the project's colour as a stripe over the card, the project as an eyebrow, who changed what as the
    /// headline, the main change as a struck-through BEFORE card and a tinted AFTER card, then the facts (owner, changed by, the other changes, the
    /// effect on other work), "Open in ProjectTracker" and "Undo change", and a box to switch to the daily digest. Tables and inline styles only, a
    /// VML button for Outlook, and a dark scheme for the mail programs that honour one. Every value is encoded here.
    /// </summary>
    public static string Change(ChangeEmail m)
    {
        var accent = System.Text.RegularExpressions.Regex.IsMatch(m.Accent, "^#[0-9a-fA-F]{6}$") ? m.Accent : "#14b8a6";
        var tint = m.AfterTint is { } t && System.Text.RegularExpressions.Regex.IsMatch(t, "^#[0-9a-fA-F]{6}$") ? t : "#e8f7f5";
        const string font = "font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
        var hidden = $"<div style=\"display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px\">{Enc(m.Preheader)}&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;</div>";
        var delta = string.IsNullOrEmpty(m.Delta) ? "" : $" <span style=\"font-size:13px;font-weight:700;color:#f59e0b\">{Enc(m.Delta)}</span>";
        var cards = m.Before is null ? "" :
            $"<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 22px\"><tr>" +
            $"<td width=\"46%\" valign=\"top\" class=\"was\" bgcolor=\"#f2f2f5\" style=\"background:#f2f2f5;border-radius:12px;padding:12px 16px;{font}\">" +
            $"<div class=\"tx3\" style=\"font-size:11px;line-height:16px;letter-spacing:.6px;color:#6e6e73;text-transform:uppercase\">Before</div>" +
            $"<div class=\"tx3\" style=\"font-size:18px;line-height:26px;font-weight:700;color:#a1a1a6;text-decoration:line-through\">{Enc(m.Before)}</div></td>" +
            $"<td width=\"8%\" align=\"center\" valign=\"middle\" class=\"tx3\" style=\"font-size:18px;color:#a1a1a6;{font}\">&rarr;</td>" +
            $"<td width=\"46%\" valign=\"top\" class=\"now\" bgcolor=\"{tint}\" style=\"background:{tint};border-radius:12px;padding:12px 16px;{font}\">" +
            $"<div style=\"font-size:11px;line-height:16px;letter-spacing:.6px;color:{accent};text-transform:uppercase;font-weight:600\">After</div>" +
            $"<div class=\"tx\" style=\"font-size:18px;line-height:26px;font-weight:700;color:#1d1d1f\">{Enc(m.After ?? "")}{delta}</div></td></tr></table>";
        var facts = m.Facts.Count == 0 ? "" :
            "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 24px\">" +
            string.Concat(m.Facts.Select(f => $"<tr><td width=\"108\" valign=\"top\" class=\"tx3\" style=\"padding:4px 0;font-size:14px;line-height:20px;color:#6e6e73;{font}\">{Enc(f.Label)}</td>" +
                $"<td valign=\"top\" class=\"tx\" style=\"padding:4px 0;font-size:14px;line-height:20px;color:#1d1d1f;{font}\">{Enc(f.Value)}</td></tr>")) + "</table>";
        const string cta = "Open in ProjectTracker";
        var button =
            $"<!--[if mso]><v:roundrect xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:w=\"urn:schemas-microsoft-com:office:word\" href=\"{Enc(m.OpenUrl)}\" style=\"height:40px;v-text-anchor:middle;width:200px\" arcsize=\"25%\" stroke=\"f\" fillcolor=\"#0a84ff\"><w:anchorlock/><center style=\"color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:bold\">{cta}</center></v:roundrect><![endif]-->" +
            $"<!--[if !mso]><!--><a href=\"{Enc(m.OpenUrl)}\" style=\"display:inline-block;background:#0a84ff;color:#ffffff;padding:10px 20px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;line-height:20px;{font}\">{cta}</a><!--<![endif]-->";
        var undo = m.UndoUrl is null ? "" : $"<td style=\"padding-left:16px;{font}\"><a class=\"lnk\" href=\"{Enc(m.UndoUrl)}\" style=\"color:#0a84ff;font-size:15px;text-decoration:none\">Undo change</a></td>";
        var digest = m.DigestUrl is null ? "" :
            $"<tr><td style=\"padding-top:12px\"><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" class=\"card\" bgcolor=\"#ffffff\" style=\"background:#ffffff;border-radius:16px\"><tr>" +
            $"<td class=\"pad\" style=\"padding:16px 20px;{font}\"><div class=\"tx\" style=\"font-size:14px;line-height:20px;font-weight:700;color:#1d1d1f\">Too many emails?</div>" +
            $"<div class=\"tx2\" style=\"font-size:13px;line-height:19px;color:#6e6e73\">Get one daily digest at {Enc(m.DigestTime)} instead of instant updates.</div></td>" +
            $"<td align=\"right\" style=\"padding:16px 20px 16px 0;{font}\"><a href=\"{Enc(m.DigestUrl)}\" class=\"chip\" style=\"display:inline-block;background:#f2f2f5;color:#1d1d1f;padding:8px 14px;border-radius:9px;font-size:14px;font-weight:600;text-decoration:none;white-space:nowrap\">Switch to digest</a></td>" +
            "</tr></table></td></tr>";
        var stop = m.UnsubscribeUrl is null ? "" : $" &middot; <a href=\"{Enc(m.UnsubscribeUrl)}\" style=\"color:#8e8e93;text-decoration:none\">Stop emails like this</a>";
        var settings = m.SettingsUrl is null ? "" : $"<a href=\"{Enc(m.SettingsUrl)}\" style=\"color:#8e8e93;text-decoration:none\">Notification settings</a>";

        return $$$"""
            <!doctype html><html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>{{{Enc(m.Headline)}}}</title>
            <!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
            <style>
              body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
              table,td{mso-table-lspace:0;mso-table-rspace:0}
              @media (max-width:520px){.wrap{padding:16px 8px!important}.pad{padding-left:20px!important;padding-right:20px!important}.h1{font-size:21px!important;line-height:28px!important}}
              @media (prefers-color-scheme:dark){
                .bg{background:#000000!important}.card{background:#1c1c1e!important}
                .tx{color:#f5f5f7!important}.tx2{color:#c7c7cc!important}.tx3{color:#98989d!important}
                .was{background:#2c2c2e!important}.now{background:#12302c!important}.chip{background:#2c2c2e!important;color:#f5f5f7!important}.lnk{color:#4da3ff!important}
              }
              [data-ogsc] .bg{background:#000000!important}[data-ogsc] .card{background:#1c1c1e!important}[data-ogsc] .tx{color:#f5f5f7!important}[data-ogsc] .tx2{color:#c7c7cc!important}
            </style></head>
            <body class="bg" style="margin:0;padding:0;background:#ebebf0;word-spacing:normal">{{{hidden}}}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" bgcolor="#ebebf0" style="background:#ebebf0"><tr><td align="center" class="wrap" style="padding:36px 14px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
                <tr><td style="padding:0 6px 14px;{{{font}}}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                  <td><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="20" height="20" bgcolor="#0a84ff" style="width:20px;height:20px;border-radius:6px;background:#0a84ff;background-image:linear-gradient(135deg,#0a84ff,#30b0c7);font-size:0;line-height:0">&nbsp;</td>
                    <td class="tx" style="padding-left:8px;font-size:13px;font-weight:700;color:#1d1d1f;{{{font}}}">ProjectTracker</td></tr></table></td>
                  <td align="right" class="tx3" style="font-size:13px;color:#6e6e73;{{{font}}}">{{{Enc(m.Workspace ?? "")}}}</td>
                </tr></table></td></tr>
                <tr><td class="card" bgcolor="#ffffff" style="background:#ffffff;border-radius:16px;border-top:6px solid {{{accent}}}">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="pad" style="padding:28px 32px;{{{font}}}">
                    <p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:{{{accent}}}">{{{Enc(m.Project)}}}</p>
                    <h1 class="h1 tx" style="margin:0 0 6px;font-size:23px;line-height:30px;font-weight:700;letter-spacing:-.3px;color:#1d1d1f">{{{Enc(m.Headline)}}}</h1>
                    <p class="tx2" style="margin:0 0 20px;font-size:14px;line-height:21px;color:#6e6e73">{{{Enc(m.Subtitle)}}}</p>
                    {{{cards}}}
                    {{{facts}}}
                    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td>{{{button}}}</td>{{{undo}}}</tr></table>
                  </td></tr></table>
                </td></tr>
                {{{digest}}}
                <tr><td align="center" style="padding:22px 12px 0;{{{font}}}">
                  <p class="tx3" style="margin:0 0 4px;font-size:12px;line-height:18px;color:#8e8e93">{{{Enc(m.Reason)}}}</p>
                  <p class="tx3" style="margin:0;font-size:12px;line-height:18px;color:#8e8e93">{{{settings}}}{{{stop}}}</p>
                </td></tr>
              </table>
            </td></tr></table></body></html>
            """;
    }
}
