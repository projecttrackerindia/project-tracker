using System.Net;

namespace ProjectManagement.Application.Features.Auth;

/// <summary>What the message is about: it sets the small label and the accent color above the headline.</summary>
public enum EmailKind { Update, Security, Invitation, Reminder, Welcome, Billing }

/// <summary>
/// The one look every e-mail shares: a dark gradient header with the product mark, a clean card with the message, one bold button and the link in words
/// for programs that block buttons. Table layout and inline styles because mail programs ignore almost everything else; the button is a real
/// (VML) button in Outlook, which would otherwise drop its padding; the header falls back to a solid color where gradients are not drawn; and a dark
/// color scheme is provided for the programs that honor it (Apple Mail, Outlook.com, Gmail's apps invert on their own).
/// </summary>
public static class EmailTemplates
{
    private static string Enc(string s) => WebUtility.HtmlEncode(s);

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
        string origin;
        try { origin = new Uri(link).GetLeftPart(UriPartial.Authority); } catch (UriFormatException) { origin = ""; }
        var host = origin.Replace("https://", "").Replace("http://", "");
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
                      <td width="30" height="30" align="center" valign="middle" bgcolor="#7c3aed" style="width:30px;height:30px;border-radius:9px;background:#7c3aed;background-image:linear-gradient(135deg,#8b5cf6,#c084fc);color:#ffffff;font-size:16px;font-weight:700;line-height:30px">&#10003;</td>
                      <td style="padding-left:11px;font-size:15px;font-weight:700;color:#ffffff;letter-spacing:.2px">Project Tracker</td>
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
                <tr><td class="pad" style="padding:20px 32px 0;font-family:Inter,'Segoe UI',Roboto,Arial,sans-serif;text-align:center">{{{foot}}}{{{stop}}}{{{links}}}
                  <p class="tx3" style="margin:6px 0 0;font-size:11px;line-height:17px;color:#a59ec3">Sent by Project Tracker{{{(host.Length > 0 ? " · " + Enc(host) : "")}}}</p></td></tr>
              </table>
            </td></tr></table></body></html>
            """;
    }
}
