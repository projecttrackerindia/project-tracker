using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Chat;

public record SetPrivateRequest(bool Enabled);
/// <param name="PublicKey">The browser's ECDH P-256 public key as a JWK (JSON). A JWK carrying a private part ("d") is refused.</param>
public record RegisterDeviceKeyRequest(string? DeviceId, string? PublicKey, string? Label);
public record ChatDeviceKeyDto(Guid UserId, string DeviceId, string PublicKey, string? Label, DateTime CreatedAt);
public record ChatKeysMeDto(IReadOnlyList<ChatDeviceKeyDto> Devices, bool HasBackup);
public record ChatKeyBackupDto(string Salt, int Iterations, string WrappedKey, string PublicKey, DateTime UpdatedAt);
public record SaveKeyBackupRequest(string? Salt, int Iterations, string? WrappedKey, string? PublicKey);
public record PeopleKeysRequest(IReadOnlyList<Guid>? UserIds);

/// <summary>
/// The shape check for an end-to-end encrypted envelope. The server cannot (and does not try to) read it: it only checks that it is the JSON the
/// browsers write - { "v": 1, "iv": …, "ct": …, "from": …, "keys": [{ "d": device id, "k": wrapped key, … }] } - and that it fits.
/// </summary>
public static class E2eEnvelope
{
    public const int MaxChars = 60000;

    public static string Clean(string? cipher)
    {
        var text = (cipher ?? "").Trim();
        if (text.Length == 0) throw new ValidationException("cipher", "A private chat message must be encrypted on your device first.");
        if (text.Length > MaxChars) throw new ValidationException("cipher", "This encrypted message is too large. Send a shorter one.");
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || v.GetInt32() != 1
                || !root.TryGetProperty("iv", out var iv) || iv.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("ct", out var ctext) || ctext.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("keys", out var keys) || keys.ValueKind != JsonValueKind.Array || keys.GetArrayLength() == 0)
                throw new ValidationException("cipher", "This is not an encrypted message.");
        }
        catch (JsonException) { throw new ValidationException("cipher", "This is not an encrypted message."); }
        return text;
    }
}

public partial class ChatService
{
    public const int MaxDevicesPerPerson = 20;
    private static readonly Regex DeviceIdShape = new("^[A-Za-z0-9_-]{8,64}$", RegexOptions.Compiled);

    private async Task RejectPrivateAsync(Guid conversationId, string what, CancellationToken ct)
    {
        if (await db.Conversations.AsNoTracking().AnyAsync(c => c.Id == conversationId && c.IsPrivate, ct))
            throw new ConflictException($"{what} are not available in a private chat yet: they could not be end-to-end encrypted.", "CHAT_PRIVATE");
    }

    /// <summary>A private chat message: ciphertext only. No mentions, files, previews or AI; the notice says only that something arrived.</summary>
    private async Task<ChatMessageDto> SendPrivateAsync(Guid tenant, Guid me, ConversationMember mine, Conversation conv, SendMessageRequest req, Guid? idempotencyId, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(req.Body)) throw new ValidationException("body", "This chat is private: the message must be encrypted on your device, not sent as text.");
        if (req.AttachmentIds is { Count: > 0 }) throw new ConflictException("Files are not available in a private chat yet: they could not be end-to-end encrypted.", "CHAT_PRIVATE");
        var cipher = E2eEnvelope.Clean(req.Cipher);
        ChatMessage? root = null;
        if (req.ThreadRootId is { } rootId)
        {
            root = await db.ChatMessages.FirstOrDefaultAsync(m => m.Id == rootId && m.ConversationId == conv.Id, ct)
                ?? throw new ValidationException("threadRootId", "The message this thread is under was not found.");
            if (root.ThreadRootId is not null || root.DeletedAt is not null || root.Kind == ChatMessageKind.System) throw new ValidationException("threadRootId", "This message cannot have a thread.");
        }
        if (req.ReplyToId is { } r && !await db.ChatMessages.AnyAsync(m => m.Id == r && m.ConversationId == conv.Id, ct))
            throw new ValidationException("replyToId", "The message you are replying to was not found.");
        if (conv.Type == ConversationType.Direct)
        {
            var other = await db.ConversationMembers.AsNoTracking().Where(m => m.ConversationId == conv.Id && m.UserId != me).Select(m => (Guid?)m.UserId).FirstOrDefaultAsync(ct);
            if (other is null || !await Eligible(tenant).AnyAsync(m => m.UserId == other, ct))
                throw new ConflictException("This person is no longer in the workspace, so you cannot send them messages.", "CHAT_PARTNER_UNAVAILABLE");
        }
        var now = clock.Now;
        var msg = new ChatMessage { ConversationId = conv.Id, SenderId = me, Kind = ChatMessageKind.User, Body = "", Cipher = cipher, ReplyToId = req.ReplyToId, ThreadRootId = root?.Id };
        if (idempotencyId is { } messageId) msg.Id = messageId;
        db.ChatMessages.Add(msg);
        if (root is null)
        {
            conv.LastMessageAt = now; conv.LastMessageId = msg.Id; conv.LastMessageSenderId = me; conv.LastMessageSnippet = EncryptedSnippet;
            mine.LastReadAt = now;
        }
        else { root.ThreadReplies++; root.ThreadLastAt = now; }
        var to = await RecipientsAsync(tenant, conv.Id, ct);
        var noticed = root is null ? await NotifyMessageAsync(conv, EncryptedSnippet, to, ct) : [];
        await db.SaveChangesAsync(ct);
        var dto = (await ToDtosAsync([msg], ct))[0];
        await PushAsync(tenant, to, ChatEvents.Message, new { conversationId = conv.Id, message = dto, projectId = (Guid?)null, conversationName = (string?)null, mentioned = Array.Empty<Guid>() }, ct);
        if (root is not null) await PushAsync(tenant, to, ChatEvents.MessageUpdated, new { conversationId = conv.Id, message = (await ToDtosAsync([root], ct))[0] }, ct);
        var nudge = noticed.Where(u => u != me).Distinct().ToList();
        if (nudge.Count > 0) await PushAsync(tenant, nudge, ChatEvents.Notification, new { }, ct);
        return dto;
    }

    /// <summary>
    /// Turns end-to-end encryption on or off for a direct chat or a group (project chats follow the project's people, so they cannot be private).
    /// In a group only an admin may change it. A line in the thread tells everyone, so nobody keeps typing believing it is still private.
    /// </summary>
    public async Task<ConversationDto> SetPrivateAsync(Guid conversationId, SetPrivateRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var mine = await MembershipAsync(conversationId, me, ct);
        var conv = await db.Conversations.FirstAsync(c => c.Id == conversationId, ct);
        if (conv.Type == ConversationType.Project) throw new ValidationException("enabled", "A project chat follows the project's people, so it cannot be a private chat. Start a group instead.");
        if (conv.Type == ConversationType.Group) RequireGroupAdmin(mine);
        if (conv.IsPrivate == req.Enabled) return await GetAsync(conversationId, ct);
        conv.IsPrivate = req.Enabled;
        var who = await NameOfAsync(me, ct);
        var line = AddSystemLine(conv, req.Enabled
            ? $"{who} turned on private chat. New messages are end-to-end encrypted: only the people here can read them (not Aura, search or the bot)."
            : $"{who} turned off private chat. New messages are no longer end-to-end encrypted.", clock.Now);
        await db.SaveChangesAsync(ct);
        await AnnounceAsync(tenant, conv, line, [], ct);
        return await GetAsync(conversationId, ct);
    }

    // ------------------------------------------------------------------ device keys (public halves only)

    private static string CleanPublicJwk(string? jwk)
    {
        var text = (jwk ?? "").Trim();
        if (text.Length is 0 or > 1000) throw new ValidationException("publicKey", "Send the device's public key.");
        try
        {
            using var doc = JsonDocument.Parse(text);
            var k = doc.RootElement;
            if (k.ValueKind != JsonValueKind.Object) throw new ValidationException("publicKey", "That is not a public key.");
            if (k.TryGetProperty("d", out _)) throw new ValidationException("publicKey", "That is a private key. Only the public key may leave the device.");
            if (!k.TryGetProperty("kty", out var kty) || kty.GetString() != "EC" || !k.TryGetProperty("crv", out var crv) || crv.GetString() != "P-256"
                || !k.TryGetProperty("x", out var x) || x.ValueKind != JsonValueKind.String || !k.TryGetProperty("y", out var y) || y.ValueKind != JsonValueKind.String)
                throw new ValidationException("publicKey", "That is not an ECDH P-256 public key.");
            return JsonSerializer.Serialize(new { kty = "EC", crv = "P-256", x = x.GetString(), y = y.GetString() });
        }
        catch (JsonException) { throw new ValidationException("publicKey", "That is not a public key."); }
    }

    private static ChatDeviceKeyDto KeyDto(ChatDeviceKey k) => new(k.UserId, k.DeviceId, k.PublicKey, k.Label, k.CreatedAt);

    public async Task<ChatKeysMeDto> MyKeysAsync(CancellationToken ct = default)
    {
        var (_, me) = Require();
        var rows = await db.ChatDeviceKeys.AsNoTracking().Where(k => k.UserId == me && k.RevokedAt == null).OrderBy(k => k.CreatedAt).ToListAsync(ct);
        return new ChatKeysMeDto(rows.Select(KeyDto).ToList(), await db.ChatKeyBackups.AsNoTracking().AnyAsync(b => b.UserId == me, ct));
    }

    public async Task<ChatDeviceKeyDto> RegisterDeviceAsync(RegisterDeviceKeyRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var deviceId = (req.DeviceId ?? "").Trim();
        if (!DeviceIdShape.IsMatch(deviceId)) throw new ValidationException("deviceId", "The device id is not valid.");
        var key = CleanPublicJwk(req.PublicKey);
        var label = string.IsNullOrWhiteSpace(req.Label) ? null : req.Label.Trim()[..Math.Min(req.Label.Trim().Length, 80)];
        var row = await db.ChatDeviceKeys.FirstOrDefaultAsync(k => k.UserId == me && k.DeviceId == deviceId, ct);
        if (row is null)
        {
            if (await db.ChatDeviceKeys.CountAsync(k => k.UserId == me && k.RevokedAt == null, ct) >= MaxDevicesPerPerson)
                throw new ConflictException($"You have {MaxDevicesPerPerson} devices set up for private chats. Remove one first.", "CHAT_DEVICE_LIMIT");
            row = new ChatDeviceKey { TenantId = tenant, UserId = me, DeviceId = deviceId, PublicKey = key, Label = label, CreatedAt = clock.Now };
            db.ChatDeviceKeys.Add(row);
        }
        else
        {
            // The same browser with a new key (it was reset or restored): the old key stops being used for new messages.
            row.PublicKey = key; row.Label = label ?? row.Label; row.RevokedAt = null; row.UpdatedAt = clock.Now;
        }
        await db.SaveChangesAsync(ct);
        return KeyDto(row);
    }

    public async Task RevokeDeviceAsync(string deviceId, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var row = await db.ChatDeviceKeys.FirstOrDefaultAsync(k => k.UserId == me && k.DeviceId == deviceId, ct) ?? throw new NotFoundException("That device was not found.", "CHAT_DEVICE_NOT_FOUND");
        row.RevokedAt ??= clock.Now;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The devices to encrypt for in a conversation: every current member's active device keys (the caller must be in it).</summary>
    public async Task<IReadOnlyList<ChatDeviceKeyDto>> ConversationKeysAsync(Guid conversationId, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        await MembershipAsync(conversationId, me, ct);
        var people = await RecipientsAsync(tenant, conversationId, ct);
        if (!people.Contains(me)) people.Add(me);
        return await KeysOfAsync(people, ct);
    }

    /// <summary>Public keys of some people in this workspace (to share a private call's room key with them). Strangers are left out.</summary>
    public async Task<IReadOnlyList<ChatDeviceKeyDto>> PeopleKeysAsync(PeopleKeysRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var wanted = (req.UserIds ?? []).Append(me).Distinct().Take(MaxGroupMembers * 2).ToList();
        var allowed = await Eligible(tenant).Where(m => wanted.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
        return await KeysOfAsync(allowed, ct);
    }

    private async Task<IReadOnlyList<ChatDeviceKeyDto>> KeysOfAsync(IReadOnlyCollection<Guid> people, CancellationToken ct)
    {
        var rows = await db.ChatDeviceKeys.AsNoTracking().Where(k => people.Contains(k.UserId) && k.RevokedAt == null).OrderBy(k => k.UserId).ThenBy(k => k.CreatedAt).ToListAsync(ct);
        return rows.Select(KeyDto).ToList();
    }

    // ------------------------------------------------------------------ recovery copy (encrypted in the browser with the person's passphrase)

    public async Task<ChatKeyBackupDto?> BackupAsync(CancellationToken ct = default)
    {
        var (_, me) = Require();
        var b = await db.ChatKeyBackups.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == me, ct);
        return b is null ? null : new ChatKeyBackupDto(b.Salt, b.Iterations, b.WrappedKey, b.PublicKey, b.UpdatedAt ?? b.CreatedAt);
    }

    public async Task<ChatKeyBackupDto> SaveBackupAsync(SaveKeyBackupRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var salt = (req.Salt ?? "").Trim();
        if (salt.Length is < 16 or > 64) throw new ValidationException("salt", "The recovery salt is not valid.");
        // Weak stretching would make the passphrase easy to guess offline from this row: 310,000 rounds of PBKDF2-SHA-256 or more (OWASP).
        if (req.Iterations is < 310_000 or > 5_000_000) throw new ValidationException("iterations", "Use at least 310,000 PBKDF2 rounds.");
        var wrapped = (req.WrappedKey ?? "").Trim();
        if (wrapped.Length is < 40 or > 4000) throw new ValidationException("wrappedKey", "The encrypted recovery key is not valid.");
        var pub = CleanPublicJwk(req.PublicKey);
        var row = await db.ChatKeyBackups.FirstOrDefaultAsync(x => x.UserId == me, ct);
        if (row is null) db.ChatKeyBackups.Add(row = new ChatKeyBackup { TenantId = tenant, UserId = me, CreatedAt = clock.Now });
        else row.UpdatedAt = clock.Now;
        row.Salt = salt; row.Iterations = req.Iterations; row.WrappedKey = wrapped; row.PublicKey = pub;
        await db.SaveChangesAsync(ct);
        return new ChatKeyBackupDto(row.Salt, row.Iterations, row.WrappedKey, row.PublicKey, row.UpdatedAt ?? row.CreatedAt);
    }
}
