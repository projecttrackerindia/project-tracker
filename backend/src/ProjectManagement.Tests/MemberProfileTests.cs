using System.Net;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// A member's profile card (role, job role, team, who they report to, their work counts) and their own profile photo: set and removed
/// only by themselves, readable by anyone who shares a workspace with them, refused to everyone else.
/// </summary>
[Collection("api")]
public class MemberProfileTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private static byte[] Png(int w = 20, int h = 20, int colorType = 6)
    {
        using var ms = new MemoryStream();
        ms.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        void Chunk(string type, byte[] data)
        {
            var len = BitConverter.GetBytes(data.Length); Array.Reverse(len); ms.Write(len);
            var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
            var crcInput = typeBytes.Concat(data).ToArray();
            ms.Write(typeBytes); ms.Write(data);
            var crc = Crc32(crcInput); var crcBytes = BitConverter.GetBytes(crc); Array.Reverse(crcBytes); ms.Write(crcBytes);
        }
        var ihdr = new List<byte>();
        void Be(List<byte> l, int v) { var b = BitConverter.GetBytes(v); Array.Reverse(b); l.AddRange(b); }
        Be(ihdr, w); Be(ihdr, h); ihdr.AddRange([8, (byte)colorType, 0, 0, 0]);
        Chunk("IHDR", ihdr.ToArray());
        var channels = colorType == 6 ? 4 : colorType == 2 ? 3 : 1;
        var raw = new List<byte>();
        for (var y = 0; y < h; y++) { raw.Add(0); for (var x = 0; x < w * channels; x++) raw.Add((byte)((x + y) % 255)); }
        using var comp = new MemoryStream();
        using (var ds = new System.IO.Compression.ZLibStream(comp, System.IO.Compression.CompressionLevel.Fastest, true)) ds.Write(raw.ToArray());
        Chunk("IDAT", comp.ToArray());
        Chunk("IEND", []);
        return ms.ToArray();
    }

    private static uint Crc32(byte[] data)
    {
        uint[] table = new uint[256];
        for (uint n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1; table[n] = c; }
        uint crc = 0xFFFFFFFF;
        foreach (var b in data) crc = table[(crc ^ b) & 0xFF] ^ (crc >> 8);
        return crc ^ 0xFFFFFFFF;
    }

    private static async Task<ApiResult> UploadAvatar(TestClient c, byte[] bytes, string type = "image/png")
    {
        using var form = new MultipartFormDataContent();
        var part = new ByteArrayContent(bytes); part.Headers.ContentType = new MediaTypeHeaderValue(type);
        form.Add(part, "file", "avatar");
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/me/avatar") { Content = form };
        if (c.Token is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.Token);
        var res = await c.Http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        return new ApiResult(res.StatusCode, string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text));
    }

    [Fact]
    public async Task A_photo_is_private_until_set_shows_up_everywhere_the_person_does_and_only_to_people_who_share_a_workspace()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var outsider = await TestClient.RegisterAsync(factory, "Nobody Here");

        Assert.False((await dev.Get("/api/v1/me")).Data!["user"]!["hasAvatar"]!.GetValue<bool>());
        Assert.False((await owner.Get("/api/v1/workspace/members")).Data!.AsArray().First(m => S(m!["userId"]) == dev.UserId.ToString())!["hasAvatar"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Raw($"/api/v1/workspace/members/{dev.UserId}/avatar")).StatusCode);

        var uploaded = await UploadAvatar(dev, Png());
        Assert.Equal(HttpStatusCode.NoContent, uploaded.Status);
        Assert.True((await dev.Get("/api/v1/me")).Data!["user"]!["hasAvatar"]!.GetValue<bool>());
        Assert.True((await owner.Get("/api/v1/workspace/members")).Data!.AsArray().First(m => S(m!["userId"]) == dev.UserId.ToString())!["hasAvatar"]!.GetValue<bool>());

        // Anyone in the same workspace can see it (including the person themselves) - it is a profile photo, not a secret.
        var seen = await owner.Raw($"/api/v1/workspace/members/{dev.UserId}/avatar");
        Assert.Equal(HttpStatusCode.OK, seen.StatusCode);
        Assert.Equal("image/png", seen.Content.Headers.ContentType!.MediaType);
        Assert.Equal(HttpStatusCode.OK, (await dev.Raw($"/api/v1/workspace/members/{dev.UserId}/avatar")).StatusCode);

        // Someone outside this workspace altogether cannot fetch it via this route (no shared workspace to allow it).
        await outsider.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Raw($"/api/v1/workspace/members/{dev.UserId}/avatar")).StatusCode);

        // A bad file, and one over the limit, are refused; the good photo already saved is untouched.
        Assert.Equal((HttpStatusCode)422, (await UploadAvatar(dev, "not a picture"u8.ToArray())).Status);
        Assert.Equal((HttpStatusCode)422, (await UploadAvatar(dev, new byte[3_200_000])).Status);
        Assert.True((await dev.Get("/api/v1/me")).Data!["user"]!["hasAvatar"]!.GetValue<bool>());

        Assert.Equal(HttpStatusCode.NoContent, (await dev.Delete("/api/v1/me/avatar")).Status);
        Assert.False((await dev.Get("/api/v1/me")).Data!["user"]!["hasAvatar"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Raw($"/api/v1/workspace/members/{dev.UserId}/avatar")).StatusCode);
    }

    [Fact]
    public async Task A_profile_shows_role_team_manager_and_work_counts_from_what_the_viewer_can_already_see()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");

        var team = await owner.Post("/api/v1/teams", new { name = "Platform" });
        Assert.True(team.Ok, team.ToString());
        var teamId = Guid.Parse(S(team.Data!["team"]!["id"]));
        Assert.True((await owner.Post($"/api/v1/teams/{teamId}/members", new { userId = dev.UserId, isLead = true })).Ok);

        var devRole = await owner.Post("/api/v1/org/roles", new { name = "Engineer", parentRoleId = (string?)null });
        Assert.Equal(HttpStatusCode.Created, devRole.Status);
        var roleId = Guid.Parse(S(devRole.Data!["id"]));
        Assert.True((await owner.Put($"/api/v1/org/members/{dev.UserId}/role", new { roleId })).Ok);

        var project = await owner.CreateProjectAsync("Atlas");
        var open = await owner.CreateTaskAsync(project, "Open one", new { title = "Open one", priority = "Medium", assigneeId = dev.UserId });
        var done = await owner.CreateTaskAsync(project, "Done one", new { title = "Done one", priority = "Medium", assigneeId = dev.UserId });
        var statuses = (await owner.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        var doneStatus = statuses.First(s => S(s!["category"]) == "Done")!["id"]!.GetValue<string>();
        Assert.True((await owner.Send(HttpMethod.Patch, $"/api/v1/tasks/{S(done["id"])}/move", new { statusId = Guid.Parse(doneStatus) })).Ok);

        var profile = await owner.Get($"/api/v1/workspace/members/{dev.UserId}/profile");
        Assert.True(profile.Ok, profile.ToString());
        var p = profile.Data!;
        Assert.Equal("Dev Developer", S(p["displayName"]));
        Assert.False(string.IsNullOrEmpty(S(p["email"])));
        Assert.Equal("Engineer", S(p["jobRole"]));
        Assert.Single(p["teams"]!.AsArray());
        Assert.Equal("Platform", S(p["teams"]![0]!["name"]));
        Assert.True(p["teams"]![0]!["isLead"]!.GetValue<bool>());
        Assert.Equal(1, p["open"]!.GetValue<int>());
        Assert.Equal(1, p["doneTotal"]!.GetValue<int>());
        Assert.False(p["isMe"]!.GetValue<bool>());
        Assert.True(p["canMessage"]!.GetValue<bool>());

        // Someone not in this workspace at all cannot look a member up.
        var outsider = await TestClient.RegisterAsync(factory);
        await outsider.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Get($"/api/v1/workspace/members/{dev.UserId}/profile")).Status);

        // Your own profile reads IsMe and offers no "message yourself" action.
        var mine = (await dev.Get($"/api/v1/workspace/members/{dev.UserId}/profile")).Data!;
        Assert.True(mine["isMe"]!.GetValue<bool>());
        Assert.False(mine["canMessage"]!.GetValue<bool>());

        // A guest never sees anyone's e-mail address, even on a profile card.
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gary Guest");
        Assert.Equal("", S((await guest.Get($"/api/v1/workspace/members/{dev.UserId}/profile")).Data!["email"]));
    }
}
