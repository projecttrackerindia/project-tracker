using System.IO.Compression;
using Microsoft.EntityFrameworkCore;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;
using ITfoxtec.Identity.Saml2;
using ITfoxtec.Identity.Saml2.Schemas;
using Microsoft.IdentityModel.Tokens.Saml2;
using Microsoft.AspNetCore.Mvc.Testing;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Single sign-on (OpenID Connect and SAML), verified domains, SCIM provisioning and social sign-in, end to end through the real protocol
/// code: the fake identity provider signs real ID tokens, the SAML responses are really signed, only DNS is simulated.
/// </summary>
[Collection("api")]
public class SsoTests(ApiFactory factory)
{
    private const string Web = "http://localhost:5173";
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private sealed record Org(TestClient Owner, string Domain, Guid TenantId);

    /// <summary>An organization on the Business plan with a verified domain of its own (unique per test: verification is global).</summary>
    private async Task<Org> OrgWithDomain()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var domain = $"acme{Guid.NewGuid():N}"[..14] + ".test";
        var added = await owner.Post("/api/v1/workspace/sso/domains", new { domain });
        Assert.True(added.Ok, added.ToString());
        var row = added.Data!["domains"]!.AsArray().Single()!;
        Assert.False(row["verified"]!.GetValue<bool>());
        var early = await owner.Post($"/api/v1/workspace/sso/domains/{S(row["id"])}/verify");
        Assert.Equal(422, (int)early.Status);   // the TXT record is not there yet
        factory.Dns.Publish(domain, S(row["txtValue"]));
        var verified = await owner.Post($"/api/v1/workspace/sso/domains/{S(row["id"])}/verify");
        Assert.True(verified.Data!["domains"]![0]!["verified"]!.GetValue<bool>(), verified.ToString());
        return new Org(owner, domain, owner.WorkspaceId);
    }

    private async Task EnableOidc(Org o, bool enforce = false, bool autoProvision = true) =>
        Assert.True((await o.Owner.Put("/api/v1/workspace/sso/connection", new
        {
            protocol = "Oidc", name = "Acme SSO", enabled = true, enforceForDomains = enforce, autoProvision, defaultRole = "Member",
            authority = "https://idp.test", clientId = "acme-app", clientSecret = "s3cret",
        })).Ok);

    private HttpClient Browser() => factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = true });

    private static Dictionary<string, string> QueryOf(Uri u) =>
        u.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries).Select(p => p.Split('=', 2))
            .ToDictionary(p => Uri.UnescapeDataString(p[0]), p => Uri.UnescapeDataString(p.ElementAtOrDefault(1) ?? ""));

    /// <summary>Hands the session cookie to the refresh endpoint, the way the web app does after a redirect sign-in.</summary>
    private static async Task<(string Token, JsonNode Me)> SessionOf(HttpClient browser)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/refresh");
        req.Headers.Add("X-Requested-With", "XMLHttpRequest");
        var res = await browser.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var token = S(JsonNode.Parse(await res.Content.ReadAsStringAsync())!["data"]!["accessToken"]);
        using var me = new HttpRequestMessage(HttpMethod.Get, "/api/v1/me");
        me.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var meRes = await browser.SendAsync(me);
        return (token, JsonNode.Parse(await meRes.Content.ReadAsStringAsync())!["data"]!);
    }

    // ------------------------------------------------------------------ OpenID Connect

    [Fact]
    public async Task Oidc_single_sign_on_provisions_the_person_and_signs_them_into_the_organization()
    {
        var o = await OrgWithDomain();
        await EnableOidc(o);
        var email = $"new.person@{o.Domain}";

        var discover = await new TestClient(factory).Send(HttpMethod.Post, "/api/v1/auth/sso/discover", new { email }, anonymous: true);
        Assert.True(discover.Data!["sso"]!.GetValue<bool>());
        Assert.Equal("Acme SSO", S(discover.Data["name"]));

        var browser = Browser();
        var start = await browser.GetAsync($"/api/v1/auth/sso/start?email={Uri.EscapeDataString(email)}&returnUrl=%2Fmy-work");
        Assert.Equal(HttpStatusCode.Redirect, start.StatusCode);
        var authorize = start.Headers.Location!;
        Assert.StartsWith("https://idp.test/authorize", authorize.ToString());
        var q = QueryOf(authorize);
        Assert.Equal("acme-app", q["client_id"]);
        Assert.Equal("S256", q["code_challenge_method"]);
        Assert.Equal(email, q["login_hint"]);

        var code = factory.Idp.Issue(new() { ["sub"] = "idp-user-1", ["email"] = email, ["name"] = "New Person", ["nonce"] = q["nonce"] });
        var back = await browser.GetAsync($"/api/v1/auth/sso/oidc/callback?code={code}&state={q["state"]}");
        Assert.Equal(HttpStatusCode.Redirect, back.StatusCode);
        Assert.Equal($"{Web}/auth/complete?to=%2Fmy-work", back.Headers.Location!.ToString());
        Assert.Contains(factory.Idp.TokenRequests, r => r.GetValueOrDefault("code") == code && r.ContainsKey("code_verifier") && r["client_secret"] == "s3cret");

        var (_, me) = await SessionOf(browser);
        Assert.Equal(email, S(me["user"]!["email"]));
        Assert.Equal(o.TenantId.ToString(), S(me["current"]!["id"]));
        Assert.Equal("Member", S(me["current"]!["role"]));
        Assert.True(me["user"]!["emailVerified"]!.GetValue<bool>());

        // the same answer cannot be used twice
        var replay = await browser.GetAsync($"/api/v1/auth/sso/oidc/callback?code={code}&state={q["state"]}");
        Assert.Contains("sso_error=SSO_STATE_EXPIRED", replay.Headers.Location!.ToString());

        // the second sign-in finds the same account by the provider's subject
        var again = await browser.GetAsync($"/api/v1/auth/sso/start?email={Uri.EscapeDataString(email)}");
        var q2 = QueryOf(again.Headers.Location!);
        var code2 = factory.Idp.Issue(new() { ["sub"] = "idp-user-1", ["email"] = email, ["nonce"] = q2["nonce"] });
        Assert.Contains("/auth/complete", (await browser.GetAsync($"/api/v1/auth/sso/oidc/callback?code={code2}&state={q2["state"]}")).Headers.Location!.ToString());
        Assert.Equal(1, factory.WithDb(db => db.Users.Count(u => u.Email == email)));
    }

    [Fact]
    public async Task Oidc_answers_that_do_not_belong_to_this_sign_in_or_this_organization_are_refused()
    {
        var o = await OrgWithDomain();
        await EnableOidc(o);
        var email = $"someone@{o.Domain}";

        // started in one browser, finished in another (no binding cookie)
        var a = Browser();
        var q = QueryOf((await a.GetAsync($"/api/v1/auth/sso/start?email={email}")).Headers.Location!);
        var code = factory.Idp.Issue(new() { ["sub"] = "s1", ["email"] = email, ["nonce"] = q["nonce"] });
        Assert.Contains("sso_error=SSO_STATE_INVALID", (await Browser().GetAsync($"/api/v1/auth/sso/oidc/callback?code={code}&state={q["state"]}")).Headers.Location!.ToString());

        // a token minted for a different sign-in (wrong nonce)
        var b = Browser();
        var qb = QueryOf((await b.GetAsync($"/api/v1/auth/sso/start?email={email}")).Headers.Location!);
        var bad = factory.Idp.Issue(new() { ["sub"] = "s1", ["email"] = email, ["nonce"] = "somebody-elses-nonce" });
        Assert.Contains("sso_error=SSO_NONCE_MISMATCH", (await b.GetAsync($"/api/v1/auth/sso/oidc/callback?code={bad}&state={qb["state"]}")).Headers.Location!.ToString());

        // the organization's provider asserting an address outside its verified domains (e.g. someone else's account)
        var victim = await TestClient.RegisterAsync(factory, "Victim");
        var c = Browser();
        var qc = QueryOf((await c.GetAsync($"/api/v1/auth/sso/start?email={email}")).Headers.Location!);
        var takeover = factory.Idp.Issue(new() { ["sub"] = "attacker", ["email"] = victim.Email, ["nonce"] = qc["nonce"] });
        Assert.Contains("sso_error=SSO_DOMAIN_NOT_VERIFIED", (await c.GetAsync($"/api/v1/auth/sso/oidc/callback?code={takeover}&state={qc["state"]}")).Headers.Location!.ToString());
        Assert.Equal(0, factory.WithDb(db => db.UserLogins.Count(l => l.Subject == "attacker")));

        // no provisioning: someone unknown is turned away
        await EnableOidc(o, autoProvision: false);
        var d = Browser();
        var qd = QueryOf((await d.GetAsync($"/api/v1/auth/sso/start?email=stranger@{o.Domain}")).Headers.Location!);
        var stranger = factory.Idp.Issue(new() { ["sub"] = "stranger", ["email"] = $"stranger@{o.Domain}", ["nonce"] = qd["nonce"] });
        Assert.Contains("sso_error=SSO_NOT_PROVISIONED", (await d.GetAsync($"/api/v1/auth/sso/oidc/callback?code={stranger}&state={qd["state"]}")).Headers.Location!.ToString());
    }

    [Fact]
    public async Task Enforced_single_sign_on_turns_away_passwords_on_the_domain()
    {
        var o = await OrgWithDomain();
        var email = $"dev@{o.Domain}";
        Assert.True((await o.Owner.Post("/api/v1/workspace/members", new { email, displayName = "Dev", role = "Member", password = "Temp#Passw0rd!" })).Ok);
        await EnableOidc(o, enforce: true);

        var login = await new TestClient(factory).Send(HttpMethod.Post, "/api/v1/auth/login", new { email, password = "Temp#Passw0rd!" }, anonymous: true);
        Assert.Equal(403, (int)login.Status);
        Assert.Equal("SSO_REQUIRED", login.ErrorCode);
        Assert.True((await new TestClient(factory).Send(HttpMethod.Post, "/api/v1/auth/sso/discover", new { email }, anonymous: true)).Data!["enforced"]!.GetValue<bool>());

        // the owner (on another domain) is unaffected, and switching enforcement off lets the password work again
        await EnableOidc(o, enforce: false);
        var again = await new TestClient(factory).Send(HttpMethod.Post, "/api/v1/auth/login", new { email, password = "Temp#Passw0rd!" }, anonymous: true);
        Assert.True(again.Ok, again.ToString());
    }

    [Fact]
    public async Task Only_owners_and_admins_of_an_organization_on_a_capable_plan_manage_single_sign_on()
    {
        var owner = await TestClient.RegisterAsync(factory, "Personal Only");
        Assert.Equal(403, (int)(await owner.Get("/api/v1/workspace/sso")).Status);   // a personal workspace
        await owner.CreateOrgAsync();
        var free = await owner.Put("/api/v1/workspace/sso/connection", new { protocol = "Oidc", enabled = false, authority = "https://idp.test", clientId = "x", clientSecret = "y" });
        Assert.Equal(403, (int)free.Status);   // advanced security is not on this plan
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Manager, "Maya");
        Assert.Equal(403, (int)(await member.Get("/api/v1/workspace/sso")).Status);

        var on = await owner.Put("/api/v1/workspace/sso/connection", new { protocol = "Oidc", enabled = true, authority = "https://idp.test", clientId = "x", clientSecret = "y" });
        Assert.Equal(422, (int)on.Status);   // no verified domain yet
        var saved = await owner.Put("/api/v1/workspace/sso/connection", new { protocol = "Oidc", enabled = false, authority = "https://idp.test", clientId = "x", clientSecret = "y" });
        Assert.True(saved.Ok, saved.ToString());
        Assert.True(saved.Data!["connection"]!["hasClientSecret"]!.GetValue<bool>());
        Assert.DoesNotContain("\"y\"", saved.Json!.ToJsonString());   // secrets never come back
        var check = await owner.Post("/api/v1/workspace/sso/check");
        Assert.True(check.Data!["ok"]!.GetValue<bool>(), check.ToString());
    }

    // ------------------------------------------------------------------ SAML

    private static X509Certificate2 IdpCertificate()
    {
        using var rsa = RSA.Create(2048);
        var req = new CertificateRequest("CN=idp.test", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var cert = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));
        return X509CertificateLoader.LoadPkcs12(cert.Export(X509ContentType.Pfx, "p"), "p", X509KeyStorageFlags.Exportable);
    }

    private static string RequestIdOf(Uri redirect)
    {
        var raw = Convert.FromBase64String(QueryOf(redirect)["SAMLRequest"]);
        using var inflate = new DeflateStream(new MemoryStream(raw), CompressionMode.Decompress);
        using var reader = new StreamReader(inflate);
        var xml = new XmlDocument(); xml.LoadXml(reader.ReadToEnd());
        return xml.DocumentElement!.GetAttribute("ID");
    }

    private static string SignedResponse(X509Certificate2 cert, string spEntityId, string acs, string requestId, string email, IEnumerable<string>? groups = null)
    {
        var config = new Saml2Configuration { Issuer = "https://idp.test/saml", SigningCertificate = cert };
        var response = new Saml2AuthnResponse(config)
        {
            InResponseTo = new Saml2Id(requestId), Status = Saml2StatusCodes.Success, Destination = new Uri(acs),
            NameId = new Saml2NameIdentifier(email, new Uri("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress")),
            ClaimsIdentity = new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, email), new Claim(ClaimTypes.Email, email), new Claim(ClaimTypes.Name, "Sam Saml"), .. (groups ?? []).Select(g => new Claim("groups", g))]),
        };
        response.CreateSecurityToken(spEntityId, subjectConfirmationLifetime: 5, issuedTokenLifetime: 60);
        var binding = new Saml2PostBinding();
        binding.Bind(response);
        return Regex.Match(binding.PostContent, "name=\"SAMLResponse\" value=\"([^\"]+)\"").Groups[1].Value;
    }

    [Fact]
    public async Task Saml_single_sign_on_accepts_a_signed_answer_and_rejects_a_forged_one()
    {
        var o = await OrgWithDomain();
        using var cert = IdpCertificate();
        var pem = cert.ExportCertificatePem();
        var saved = await o.Owner.Put("/api/v1/workspace/sso/connection", new
        {
            protocol = "Saml", name = "Acme Okta", enabled = true, autoProvision = true, samlEntityId = "https://idp.test/saml", samlSsoUrl = "https://idp.test/sso", samlCertificate = pem,
        });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal("CN=idp.test", S(saved.Data!["connection"]!["certificateSubject"]));
        var sp = saved.Data["serviceProvider"]!;
        var entityId = S(sp["samlEntityId"]); var acs = S(sp["samlAcsUrl"]);
        var metadata = await Browser().GetStringAsync(new Uri(entityId).PathAndQuery);
        Assert.Contains(acs, metadata);

        var email = $"sam@{o.Domain}";
        var browser = Browser();
        var start = await browser.GetAsync($"/api/v1/auth/sso/start?email={email}");
        Assert.StartsWith("https://idp.test/sso", start.Headers.Location!.ToString());
        var relay = QueryOf(start.Headers.Location!)["RelayState"];
        var id = RequestIdOf(start.Headers.Location!);

        var form = new FormUrlEncodedContent(new Dictionary<string, string> { ["SAMLResponse"] = SignedResponse(cert, entityId, acs, id, email), ["RelayState"] = relay });
        var back = await browser.PostAsync("/api/v1/auth/sso/saml/acs", form);
        Assert.Equal(HttpStatusCode.Redirect, back.StatusCode);
        Assert.Contains("/auth/complete", back.Headers.Location!.ToString());
        var (_, me) = await SessionOf(browser);
        Assert.Equal(email, S(me["user"]!["email"]));
        Assert.Equal("Sam Saml", S(me["user"]!["displayName"]));

        // signed with a different key: refused
        using var forger = IdpCertificate();
        var b2 = Browser();
        var s2 = await b2.GetAsync($"/api/v1/auth/sso/start?email={email}");
        var forged = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["SAMLResponse"] = SignedResponse(forger, entityId, acs, RequestIdOf(s2.Headers.Location!), email), ["RelayState"] = QueryOf(s2.Headers.Location!)["RelayState"],
        });
        Assert.Contains("sso_error=SSO_TOKEN_INVALID", (await b2.PostAsync("/api/v1/auth/sso/saml/acs", forged)).Headers.Location!.ToString());
    }

    // ------------------------------------------------------------------ SCIM

    private HttpClient Scim(string token)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }

    private static StringContent ScimBody(object o) => new(System.Text.Json.JsonSerializer.Serialize(o), Encoding.UTF8, "application/scim+json");
    private static async Task<JsonNode> Read(HttpResponseMessage r) => JsonNode.Parse(await r.Content.ReadAsStringAsync())!;

    [Fact]
    public async Task Scim_provisions_deactivates_and_removes_members_and_manages_teams()
    {
        var o = await OrgWithDomain();
        var created = await o.Owner.Post("/api/v1/workspace/sso/scim-tokens", new { name = "Entra ID" });
        Assert.Equal(HttpStatusCode.Created, created.Status);
        var secret = S(created.Data!["secret"]);
        Assert.StartsWith("scim_", secret);

        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync("/scim/v2/Users")).StatusCode);
        var scim = Scim(secret);
        var config = await Read(await scim.GetAsync("/scim/v2/ServiceProviderConfig"));
        Assert.True(config["patch"]!["supported"]!.GetValue<bool>());

        // not on a verified domain: refused
        var outside = await scim.PostAsync("/scim/v2/Users", ScimBody(new { schemas = new[] { "urn:ietf:params:scim:schemas:core:2.0:User" }, userName = "someone@elsewhere.test" }));
        Assert.Equal(HttpStatusCode.BadRequest, outside.StatusCode);
        Assert.Equal("invalidValue", S((await Read(outside))["scimType"]));

        var email = $"pat.lee@{o.Domain}";
        var post = await scim.PostAsync("/scim/v2/Users", ScimBody(new
        {
            schemas = new[] { "urn:ietf:params:scim:schemas:core:2.0:User" }, userName = email, externalId = "ext-42",
            name = new { givenName = "Pat", familyName = "Lee" }, active = true,
        }));
        Assert.Equal(HttpStatusCode.Created, post.StatusCode);
        Assert.Equal("application/scim+json", post.Content.Headers.ContentType!.MediaType);
        var user = await Read(post);
        var id = S(user["id"]);
        Assert.Equal("Pat Lee", S(user["displayName"]));
        Assert.Equal("ext-42", S(user["externalId"]));
        Assert.True(user["active"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Conflict, (await scim.PostAsync("/scim/v2/Users", ScimBody(new { userName = email }))).StatusCode);

        var found = await Read(await scim.GetAsync($"/scim/v2/Users?filter={Uri.EscapeDataString($"userName eq \"{email}\"")}"));
        Assert.Equal(1, found["totalResults"]!.GetValue<int>());
        Assert.Equal(1, (await Read(await scim.GetAsync($"/scim/v2/Users?filter={Uri.EscapeDataString("externalId eq \"ext-42\"")}")))["totalResults"]!.GetValue<int>());
        Assert.Contains((await o.Owner.Get("/api/v1/workspace/members")).Data!.AsArray(), m => S(m!["email"]) == email);

        // a team (SCIM group) with Pat in it
        var group = await Read(await scim.PostAsync("/scim/v2/Groups", ScimBody(new { displayName = "Platform", members = new[] { new { value = id } } })));
        Assert.Single(group["members"]!.AsArray());

        // Entra-style deactivation removes the membership (and the team seat), not the account
        var off = await scim.PatchAsync($"/scim/v2/Users/{id}", ScimBody(new { schemas = new[] { "urn:ietf:params:scim:api:messages:2.0:PatchOp" }, Operations = new[] { new { op = "Replace", path = "active", value = "False" } } }));
        Assert.Equal(HttpStatusCode.OK, off.StatusCode);
        Assert.False((await Read(off))["active"]!.GetValue<bool>());
        Assert.DoesNotContain((await o.Owner.Get("/api/v1/workspace/members")).Data!.AsArray(), m => S(m!["email"]) == email);
        Assert.Empty((await Read(await scim.GetAsync($"/scim/v2/Groups/{S(group["id"])}")))["members"]!.AsArray());
        Assert.Equal(1, factory.WithDb(db => db.Users.Count(u => u.Email == email)));

        // Okta-style reactivation (a value object)
        var on = await scim.PatchAsync($"/scim/v2/Users/{id}", ScimBody(new { Operations = new[] { new { op = "replace", value = new { active = true } } } }));
        Assert.True((await Read(on))["active"]!.GetValue<bool>());

        // the owner cannot be deprovisioned
        var ownerOff = await scim.DeleteAsync($"/scim/v2/Users/{o.Owner.UserId}");
        Assert.Equal(HttpStatusCode.BadRequest, ownerOff.StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await scim.DeleteAsync($"/scim/v2/Users/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await scim.GetAsync($"/scim/v2/Users/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await scim.DeleteAsync($"/scim/v2/Groups/{S(group["id"])}")).StatusCode);

        // a revoked token stops working at once
        await o.Owner.Delete($"/api/v1/workspace/sso/scim-tokens/{S(created.Data["token"]!["id"])}");
        Assert.Equal(HttpStatusCode.Unauthorized, (await scim.GetAsync("/scim/v2/Users")).StatusCode);
    }

    // ------------------------------------------------------------------ Google (social sign-in)

    private async Task<HttpResponseMessage> GoogleSignIn(HttpClient browser, string sub, string email, bool verified = true)
    {
        var start = await browser.GetAsync("/api/v1/auth/external/google/start");
        Assert.Equal(HttpStatusCode.Redirect, start.StatusCode);
        Assert.StartsWith("https://accounts.google.com/authorize", start.Headers.Location!.ToString());
        var q = QueryOf(start.Headers.Location!);
        var code = factory.Idp.Issue(new() { ["sub"] = sub, ["email"] = email, ["email_verified"] = verified, ["name"] = "Gina Google", ["nonce"] = q["nonce"] });
        return await browser.GetAsync($"/api/v1/auth/external/google/callback?code={code}&state={q["state"]}");
    }

    [Fact]
    public async Task Google_sign_in_creates_an_account_links_by_verified_email_and_respects_enforced_sso()
    {
        var providers = await new TestClient(factory).Send(HttpMethod.Get, "/api/v1/auth/providers", anonymous: true);
        Assert.Contains(providers.Data!["providers"]!.AsArray(), p => S(p!["id"]) == "google");

        // someone new
        var email = $"gina-{Guid.NewGuid():N}@gmail.test";
        var browser = Browser();
        var done = await GoogleSignIn(browser, $"g-{Guid.NewGuid():N}", email);
        Assert.Contains("/auth/complete", done.Headers.Location!.ToString());
        var (_, me) = await SessionOf(browser);
        Assert.Equal(email, S(me["user"]!["email"]));
        Assert.Equal("Gina Google", S(me["user"]!["displayName"]));

        // an existing account: linked only when Google vouches for the address
        var existing = await TestClient.RegisterAsync(factory, "Existing");
        var unverified = await GoogleSignIn(Browser(), $"g-{Guid.NewGuid():N}", existing.Email, verified: false);
        Assert.Contains("sso_error=EXTERNAL_EMAIL_UNVERIFIED", unverified.Headers.Location!.ToString());
        var b2 = Browser();
        Assert.Contains("/auth/complete", (await GoogleSignIn(b2, $"g-{Guid.NewGuid():N}", existing.Email)).Headers.Location!.ToString());
        Assert.Equal(existing.Email, S((await SessionOf(b2)).Me["user"]!["email"]));
        var logins = await existing.Get("/api/v1/me/logins");
        Assert.Contains(logins.Data!.AsArray(), l => S(l!["provider"]) == "google");

        // a company that requires its own single sign-on cannot be bypassed with Google
        var o = await OrgWithDomain();
        await EnableOidc(o, enforce: true);
        var blocked = await GoogleSignIn(Browser(), $"g-{Guid.NewGuid():N}", $"anyone@{o.Domain}");
        Assert.Contains("sso_error=SSO_REQUIRED", blocked.Headers.Location!.ToString());
    }

    [Fact]
    public async Task People_with_two_step_verification_still_enter_their_code_after_google()
    {
        var c = await TestClient.RegisterAsync(factory, "Careful");
        var setup = await c.Post("/api/v1/me/mfa/setup", new { password = "Passw0rd!x" });
        var secret = S(setup.Data!["secret"]);
        Assert.True((await c.Post("/api/v1/me/mfa/enable", new { code = ProjectManagement.Application.Common.Totp.Compute(secret, ProjectManagement.Application.Common.Totp.StepOf(DateTime.UtcNow)) })).Ok);

        var res = await GoogleSignIn(Browser(), $"g-{Guid.NewGuid():N}", c.Email);
        var location = res.Headers.Location!.ToString();
        Assert.StartsWith($"{Web}/login?mfa_challenge=", location);
        Assert.Contains("via=google", location);
    }

    // ------------------------------------------------------------------ group to team mapping

    private async Task<Guid> Team(Org o, string name) => Guid.Parse(S((await o.Owner.Post("/api/v1/teams", new { name })).Data!["team"]!["id"]));

    private async Task SignIn(Org o, string email, string sub, object? groups)
    {
        var b = Browser();
        var q = QueryOf((await b.GetAsync($"/api/v1/auth/sso/start?email={Uri.EscapeDataString(email)}")).Headers.Location!);
        var claims = new Dictionary<string, object> { ["sub"] = sub, ["email"] = email, ["nonce"] = q["nonce"] };
        if (groups is not null) claims["groups"] = groups;
        var code = factory.Idp.Issue(claims);
        var done = await b.GetAsync($"/api/v1/auth/sso/oidc/callback?code={code}&state={q["state"]}");
        Assert.DoesNotContain("sso_error", done.Headers.Location!.ToString());
    }

    private List<Guid> TeamsOf(Guid tenant, string email) => factory.WithDb(db =>
    {
        var uid = db.Users.IgnoreQueryFilters().Single(u => u.NormalizedEmail == email.Trim().ToLowerInvariant()).Id;
        return db.TeamMembers.IgnoreQueryFilters().Where(m => m.TenantId == tenant && m.UserId == uid).Select(m => m.TeamId).ToList();
    });

    [Fact]
    public async Task Groups_from_the_provider_put_people_in_teams_and_take_them_out_again()
    {
        var o = await OrgWithDomain();
        await EnableOidc(o);
        var eng = await Team(o, "Engineering"); var fin = await Team(o, "Finance"); var manual = await Team(o, "Book club");
        foreach (var (g, t) in new[] { ("eng-group", eng), ("FIN-GROUP", fin) })
            Assert.True((await o.Owner.Post("/api/v1/workspace/sso/group-mappings", new { group = g, teamId = t })).Ok);
        Assert.Equal(409, (int)(await o.Owner.Post("/api/v1/workspace/sso/group-mappings", new { group = "ENG-group", teamId = eng })).Status);   // same group, any case

        var email = $"gina@{o.Domain}";
        await SignIn(o, email, "g1", new[] { "eng-group", "unmapped" });
        Assert.Equal([eng], TeamsOf(o.TenantId, email));

        // joined by hand: never touched by sign-in
        var uid = factory.WithDb(db => db.Users.IgnoreQueryFilters().Single(u => u.NormalizedEmail == email.Trim().ToLowerInvariant()).Id);
        Assert.True((await o.Owner.Post($"/api/v1/teams/{manual}/members", new { userId = uid })).Ok);

        await SignIn(o, email, "g1", new[] { "fin-group" });   // group names compare without regard to case; engineering is no longer reported
        Assert.Equal(new[] { fin, manual }.Order().ToList(), TeamsOf(o.TenantId, email).Order().ToList());

        await SignIn(o, email, "g1", new[] { "eng-group" });    // back to engineering
        Assert.Equal(new[] { eng, manual }.Order().ToList(), TeamsOf(o.TenantId, email).Order().ToList());

        await SignIn(o, email, "g1", null);                    // no group claim (what a provider sends for someone in no group): the teams SSO added go, the manual one stays
        Assert.Equal([manual], TeamsOf(o.TenantId, email));
        Assert.True(factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.TenantId == o.TenantId && a.Action == "sso.groups_synced")));
    }

    [Fact]
    public async Task A_team_of_a_group_gives_access_to_the_documents_shared_with_that_team_and_only_for_that_workspace()
    {
        var o = await OrgWithDomain();
        await EnableOidc(o);
        var eng = await Team(o, "Engineering");
        await o.Owner.Post("/api/v1/workspace/sso/group-mappings", new { group = "eng", teamId = eng });
        var brd = Guid.Parse(S((await o.Owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        var made = await o.Owner.Post("/api/v1/documents", new { title = "Team only plan", typeId = brd, visibility = "Private" });
        var doc = S(made.Data!["item"]!["id"]);
        Assert.True((await o.Owner.Post($"/api/v1/documents/{doc}/grants", new { principalType = "Team", principalId = eng, level = "Viewer" })).Ok);

        var email = $"hal@{o.Domain}";
        await SignIn(o, email, "h1", new[] { "eng" });
        var b = Browser();
        var q = QueryOf((await b.GetAsync($"/api/v1/auth/sso/start?email={Uri.EscapeDataString(email)}")).Headers.Location!);
        await b.GetAsync($"/api/v1/auth/sso/oidc/callback?code={factory.Idp.Issue(new() { ["sub"] = "h1", ["email"] = email, ["nonce"] = q["nonce"], ["groups"] = new[] { "eng" } })}&state={q["state"]}");
        var (token, me) = await SessionOf(b);
        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/documents/{doc}");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        req.Headers.Add("X-Workspace-Id", o.TenantId.ToString());
        Assert.Equal(HttpStatusCode.OK, (await factory.CreateClient().SendAsync(req)).StatusCode);

        // the mapping of another workspace changes nothing here
        var other = await OrgWithDomain();
        var foreign = await Team(other, "Engineering");
        Assert.Equal(422, (int)(await o.Owner.Post("/api/v1/workspace/sso/group-mappings", new { group = "x", teamId = foreign })).Status);
    }

    [Fact]
    public async Task Only_admins_of_a_business_workspace_manage_the_mappings()
    {
        var o = await OrgWithDomain();
        var team = await Team(o, "Ops");
        var member = await o.Owner.AddMemberAsync(factory, TenantRole.Member);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/workspace/sso/group-mappings")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/workspace/sso/group-mappings", new { group = "ops", teamId = team })).Status);
        Assert.False((await o.Owner.Post("/api/v1/workspace/sso/group-mappings", new { group = "", teamId = team })).Ok);
    }

    [Fact]
    public async Task Saml_group_attributes_map_to_teams_too()
    {
        var o = await OrgWithDomain();
        using var cert = IdpCertificate();
        var saved = await o.Owner.Put("/api/v1/workspace/sso/connection", new { protocol = "Saml", name = "Okta", enabled = true, autoProvision = true, samlEntityId = "https://idp.test/saml", samlSsoUrl = "https://idp.test/sso", samlCertificate = cert.ExportCertificatePem() });
        var entityId = S(saved.Data!["serviceProvider"]!["samlEntityId"]); var acs = S(saved.Data["serviceProvider"]!["samlAcsUrl"]);
        var ops = await Team(o, "Operations");
        Assert.True((await o.Owner.Post("/api/v1/workspace/sso/group-mappings", new { group = "CN=ops,OU=Groups", teamId = ops })).Ok);

        var email = $"olga@{o.Domain}";
        var browser = Browser();
        var start = await browser.GetAsync($"/api/v1/auth/sso/start?email={email}");
        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["SAMLResponse"] = SignedResponse(cert, entityId, acs, RequestIdOf(start.Headers.Location!), email, ["CN=ops,OU=Groups", "other"]),
            ["RelayState"] = QueryOf(start.Headers.Location!)["RelayState"],
        });
        Assert.Equal(HttpStatusCode.Redirect, (await browser.PostAsync("/api/v1/auth/sso/saml/acs", form)).StatusCode);
        Assert.Equal([ops], TeamsOf(o.TenantId, email));
    }
}
