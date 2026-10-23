using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Vault;

/// <summary>
/// The vault's encryption, on top of the workspace data keys of <see cref="EnvelopeCrypto"/>:
/// <list type="bullet">
/// <item>every item has its own 256-bit key, made fresh whenever its secret changes; the item's fields are one JSON document encrypted with it
/// (AES-256-GCM) and bound to the workspace and the item (additional data), so a cipher text copied to another row does not open;</item>
/// <item>the item key is encrypted with the workspace's active data key (also bound to the item), which the platform's master key or Cloud KMS
/// wraps, so rotating the workspace key only re-wraps item keys and never touches a value;</item>
/// <item>reused passwords are found by a keyed fingerprint (HMAC-SHA256 under a key derived from the workspace's first data key), so the same
/// password is recognised without keeping it, and the fingerprint is useless without the workspace key.</item>
/// </list>
/// Plain values exist only in memory for the length of a request; key bytes are cleared after use.
/// </summary>
public class VaultCrypto(EnvelopeCrypto envelope)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static string KeyAad(Guid tenant, Guid item) => $"vault-key|{tenant:N}|{item:N}";
    private static string FieldsAad(Guid tenant, Guid item) => $"vault|{tenant:N}|{item:N}";
    private static string FileAad(Guid tenant, Guid item, Guid file) => $"vault-file|{tenant:N}|{item:N}|{file:N}";

    /// <summary>Encrypts the fields with a new item key. Returns the cipher text, the wrapped key and the workspace key version that wraps it.</summary>
    public async Task<(string Cipher, string WrappedKey, int KeyVersion)> SealAsync(Guid tenant, Guid item, IReadOnlyDictionary<string, string> fields, CancellationToken ct)
    {
        var active = await envelope.ActiveKeyAsync(tenant, ct);
        var itemKey = RandomNumberGenerator.GetBytes(32);
        try
        {
            var cipher = envelope.Encrypt(new DataKey(0, itemKey), JsonSerializer.Serialize(fields, Json), FieldsAad(tenant, item));
            var wrapped = envelope.Encrypt(active, Convert.ToBase64String(itemKey), KeyAad(tenant, item));
            return (cipher, wrapped, active.Version);
        }
        finally { CryptographicOperations.ZeroMemory(itemKey); }
    }

    /// <summary>Decrypts the fields of an item (or of one of its earlier versions).</summary>
    public async Task<Dictionary<string, string>> OpenAsync(Guid tenant, Guid item, string cipher, string wrappedKey, int keyVersion, CancellationToken ct)
    {
        var itemKey = await ItemKeyAsync(tenant, item, wrappedKey, keyVersion, ct);
        try
        {
            var json = envelope.Decrypt(new DataKey(0, itemKey), cipher, FieldsAad(tenant, item));
            return JsonSerializer.Deserialize<Dictionary<string, string>>(json, Json) ?? [];
        }
        finally { CryptographicOperations.ZeroMemory(itemKey); }
    }

    public async Task<byte[]> SealFileAsync(Guid tenant, Guid item, Guid file, string wrappedKey, int keyVersion, byte[] data, CancellationToken ct)
    {
        var itemKey = await ItemKeyAsync(tenant, item, wrappedKey, keyVersion, ct);
        try { return envelope.EncryptBytes(new DataKey(0, itemKey), data, FileAad(tenant, item, file)); }
        finally { CryptographicOperations.ZeroMemory(itemKey); }
    }

    public async Task<byte[]> OpenFileAsync(Guid tenant, Guid item, Guid file, string wrappedKey, int keyVersion, byte[] cipher, CancellationToken ct)
    {
        var itemKey = await ItemKeyAsync(tenant, item, wrappedKey, keyVersion, ct);
        try { return envelope.DecryptBytes(new DataKey(0, itemKey), cipher, FileAad(tenant, item, file)); }
        finally { CryptographicOperations.ZeroMemory(itemKey); }
    }

    /// <summary>Moves a wrapped item key to the workspace's active data key (after a rotation). Returns null when it is already there.</summary>
    public async Task<(string WrappedKey, int KeyVersion)?> RewrapAsync(Guid tenant, Guid item, string wrappedKey, int keyVersion, CancellationToken ct)
    {
        var active = await envelope.ActiveKeyAsync(tenant, ct);
        if (keyVersion == active.Version) return null;
        var itemKey = await ItemKeyAsync(tenant, item, wrappedKey, keyVersion, ct);
        try { return (envelope.Encrypt(active, Convert.ToBase64String(itemKey), KeyAad(tenant, item)), active.Version); }
        finally { CryptographicOperations.ZeroMemory(itemKey); }
    }

    private async Task<byte[]> ItemKeyAsync(Guid tenant, Guid item, string wrappedKey, int keyVersion, CancellationToken ct)
    {
        var dataKey = await envelope.KeyAsync(tenant, keyVersion, ct);
        return Convert.FromBase64String(envelope.Decrypt(dataKey, wrappedKey, KeyAad(tenant, item)));
    }

    /// <summary>The keyed fingerprint of a password: equal passwords give equal fingerprints within a workspace, and nothing outside it.</summary>
    public async Task<string> FingerprintAsync(Guid tenant, string password, CancellationToken ct)
    {
        await envelope.ActiveKeyAsync(tenant, ct);   // a workspace's first key is made on first use
        var first = await envelope.KeyAsync(tenant, 1, ct);
        var key = HKDF.DeriveKey(HashAlgorithmName.SHA256, first.Key, 32, info: Encoding.UTF8.GetBytes("vault-password-fingerprint"));
        try { return Convert.ToHexString(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(password))).ToLowerInvariant(); }
        finally { CryptographicOperations.ZeroMemory(key); }
    }
}

/// <summary>Time-based one-time codes (RFC 6238), from a base32 secret or an otpauth:// address.</summary>
public static class VaultTotp
{
    public sealed record Spec(byte[] Secret, int Digits, int Period, HashAlgorithmName Algorithm);

    /// <summary>Reads a secret as people paste it: "JBSW Y3DP EHPK 3PXP", or "otpauth://totp/Bank:me?secret=…&amp;digits=6&amp;period=30".</summary>
    public static Spec? Parse(string? text)
    {
        var t = (text ?? "").Trim();
        if (t.Length == 0) return null;
        int digits = 6, period = 30; var alg = HashAlgorithmName.SHA1; string secret = t;
        if (t.StartsWith("otpauth://", StringComparison.OrdinalIgnoreCase))
        {
            if (!Uri.TryCreate(t, UriKind.Absolute, out var uri) || !uri.Host.Equals("totp", StringComparison.OrdinalIgnoreCase)) return null;
            var q = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Select(p => p.Split('=', 2)).Where(p => p.Length == 2)
                .ToDictionary(p => Uri.UnescapeDataString(p[0]).ToLowerInvariant(), p => Uri.UnescapeDataString(p[1]));
            if (!q.TryGetValue("secret", out var s)) return null;
            secret = s;
            if (q.TryGetValue("digits", out var d) && int.TryParse(d, CultureInfo.InvariantCulture, out var dv) && dv is 6 or 7 or 8) digits = dv;
            if (q.TryGetValue("period", out var pr) && int.TryParse(pr, CultureInfo.InvariantCulture, out var pv) && pv is >= 15 and <= 120) period = pv;
            if (q.TryGetValue("algorithm", out var a))
                alg = a.ToUpperInvariant() switch { "SHA256" => HashAlgorithmName.SHA256, "SHA512" => HashAlgorithmName.SHA512, _ => HashAlgorithmName.SHA1 };
        }
        var bytes = Base32(secret);
        return bytes is { Length: >= 10 } ? new Spec(bytes, digits, period, alg) : null;
    }

    public static (string Code, int SecondsLeft) Now(Spec s, DateTimeOffset now)
    {
        var unix = now.ToUnixTimeSeconds();
        var counter = unix / s.Period;
        var msg = new byte[8];
        for (var i = 7; i >= 0; i--) { msg[i] = (byte)(counter & 0xff); counter >>= 8; }
        byte[] hash = s.Algorithm == HashAlgorithmName.SHA256 ? HMACSHA256.HashData(s.Secret, msg)
            : s.Algorithm == HashAlgorithmName.SHA512 ? HMACSHA512.HashData(s.Secret, msg) : HMACSHA1.HashData(s.Secret, msg);
        var offset = hash[^1] & 0x0f;
        var bin = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        var code = (bin % (int)Math.Pow(10, s.Digits)).ToString(CultureInfo.InvariantCulture).PadLeft(s.Digits, '0');
        return (code, (int)(s.Period - unix % s.Period));
    }

    /// <summary>RFC 4648 base32 (spaces, dashes and padding ignored, any case); null when it is not base32.</summary>
    public static byte[]? Base32(string text)
    {
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        var clean = new string(text.Where(c => !char.IsWhiteSpace(c) && c != '-' && c != '=').Select(char.ToUpperInvariant).ToArray());
        if (clean.Length == 0) return null;
        var output = new List<byte>(clean.Length * 5 / 8);
        int buffer = 0, bits = 0;
        foreach (var c in clean)
        {
            var v = alphabet.IndexOf(c);
            if (v < 0) return null;
            buffer = (buffer << 5) | v; bits += 5;
            if (bits >= 8) { bits -= 8; output.Add((byte)((buffer >> bits) & 0xff)); }
        }
        return [.. output];
    }
}

/// <summary>
/// How guessable a password is, 0 (guessed at once) to 4 (strong): its length and variety, less what attackers try first (common passwords,
/// keyboard rows, runs like "1234" or "aaaa", a word with a year or "@123" on the end).
/// </summary>
public static partial class PasswordStrength
{
    private static readonly HashSet<string> Common = new(StringComparer.OrdinalIgnoreCase)
    {
        "password", "passw0rd", "admin", "welcome", "qwerty", "letmein", "iloveyou", "monkey", "dragon", "football", "sunshine", "princess",
        "india", "bharat", "test", "guest", "root", "changeme", "secret", "login", "master", "hello", "abc", "default", "company",
    };
    private static readonly string[] Rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "abcdefghijklmnopqrstuvwxyz"];

    public static int Score(string? password)
    {
        var p = password ?? "";
        if (p.Length == 0) return 0;
        var classes = (p.Any(char.IsLower) ? 1 : 0) + (p.Any(char.IsUpper) ? 1 : 0) + (p.Any(char.IsDigit) ? 1 : 0) + (p.Any(c => !char.IsLetterOrDigit(c)) ? 1 : 0);
        var pool = (p.Any(char.IsLower) ? 26 : 0) + (p.Any(char.IsUpper) ? 26 : 0) + (p.Any(char.IsDigit) ? 10 : 0) + (p.Any(c => !char.IsLetterOrDigit(c)) ? 33 : 0);
        var unique = p.Distinct().Count();
        var bits = p.Length * Math.Log2(Math.Max(pool, 2)) * Math.Min(1.0, unique / (double)Math.Max(p.Length * 0.6, 1));
        var core = Trailer().Replace(p.ToLowerInvariant(), "");
        if (Common.Contains(core) || Common.Any(w => core.Contains(w, StringComparison.Ordinal) && core.Length <= w.Length + 4)) bits = Math.Min(bits, 20);
        // A word with a year, digits or "@123" on the end ("Fivestar2024", "Summer@2024") is the first shape people pick and attackers try:
        // the word is worth what a word is worth (about 2.5 bits a letter), the ending a little more.
        if (core.Length > 0 && core.Length < p.Length && core.All(char.IsAsciiLetter)) bits = Math.Min(bits, core.Length * 2.5 + 10);
        else if (p.All(char.IsAsciiLetter) && p.Length <= 12 && p.Skip(1).All(char.IsLower)) bits = Math.Min(bits, p.Length * 2.5);
        if (Rows.Any(r => Runs(p.ToLowerInvariant(), r) >= 4)) bits -= 15;
        if (Repeated().IsMatch(p)) bits -= 10;
        if (classes == 1) bits -= 8;
        // A passphrase of several words is strong even without symbols.
        if (p.Count(c => c is ' ' or '-' or '.') >= 3 && p.Length >= 20) bits = Math.Max(bits, 70);
        return bits switch { < 28 => 0, < 36 => 1, < 50 => 2, < 64 => 3, _ => 4 };
    }

    private static int Runs(string p, string row)
    {
        var best = 0;
        for (var i = 0; i < p.Length; i++)
            for (var len = 3; i + len <= p.Length; len++)
            {
                var piece = p.Substring(i, len);
                if (row.Contains(piece, StringComparison.Ordinal) || row.Contains(new string(piece.Reverse().ToArray()), StringComparison.Ordinal)) best = Math.Max(best, len);
                else break;
            }
        return best;
    }

    [GeneratedRegex(@"(?:19|20)\d\d$|@?\d{1,4}[!@#$]*$")] private static partial Regex Trailer();
    [GeneratedRegex(@"(.)\1{3,}")] private static partial Regex Repeated();
}
