using System.Security.Cryptography;
using System.Text;

namespace ProjectManagement.Application.Common;

/// <summary>
/// Time-based one-time passwords as used by authenticator apps (RFC 6238: HMAC-SHA1, 6 digits, 30 second steps), plus the Base32
/// text form those apps expect for the shared secret (RFC 4648).
/// </summary>
public static class Totp
{
    public const int Digits = 6;
    public const int PeriodSeconds = 30;
    private const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    /// <summary>A fresh 160-bit secret in Base32.</summary>
    public static string NewSecret() => Base32Encode(RandomNumberGenerator.GetBytes(20));

    public static long StepOf(DateTime utc) => new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)).ToUnixTimeSeconds() / PeriodSeconds;

    /// <summary>The code an authenticator app shows for the given time step.</summary>
    public static string Compute(string secret, long step)
    {
        var counter = new byte[8];
        for (var i = 7; i >= 0; i--, step >>= 8) counter[i] = (byte)(step & 0xFF);
        var hash = HMACSHA1.HashData(Base32Decode(secret), counter);
        var offset = hash[^1] & 0x0F;
        var binary = ((hash[offset] & 0x7F) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        return (binary % 1_000_000).ToString(new string('0', Digits));
    }

    /// <summary>
    /// Accepts the current step and one either side (clock drift), but never a step at or before <paramref name="lastUsedStep"/>,
    /// so an intercepted code cannot be replayed within its lifetime.
    /// </summary>
    public static bool TryVerify(string secret, string code, DateTime utcNow, long lastUsedStep, out long matchedStep)
    {
        matchedStep = 0;
        if (code.Length != Digits || !code.All(char.IsAsciiDigit)) return false;
        var now = StepOf(utcNow);
        var ok = false;
        for (var step = now - 1; step <= now + 1; step++)
        {
            if (step <= lastUsedStep) continue;
            // Compare every candidate in constant time so timing does not reveal which step matched.
            if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Compute(secret, step)), Encoding.ASCII.GetBytes(code)) && !ok)
            { ok = true; matchedStep = step; }
        }
        return ok;
    }

    /// <summary>The <c>otpauth://</c> link that authenticator apps read from a QR code.</summary>
    public static string OtpAuthUri(string issuer, string account, string secret) =>
        $"otpauth://totp/{Uri.EscapeDataString(issuer)}:{Uri.EscapeDataString(account)}?secret={secret}&issuer={Uri.EscapeDataString(issuer)}&algorithm=SHA1&digits={Digits}&period={PeriodSeconds}";

    public static string Base32Encode(ReadOnlySpan<byte> data)
    {
        var sb = new StringBuilder((data.Length * 8 + 4) / 5);
        int buffer = 0, bits = 0;
        foreach (var b in data)
        {
            buffer = (buffer << 8) | b; bits += 8;
            while (bits >= 5) { sb.Append(Alphabet[(buffer >> (bits - 5)) & 31]); bits -= 5; }
        }
        if (bits > 0) sb.Append(Alphabet[(buffer << (5 - bits)) & 31]);
        return sb.ToString();
    }

    public static byte[] Base32Decode(string text)
    {
        var clean = text.Replace(" ", "").Replace("-", "").TrimEnd('=').ToUpperInvariant();
        var bytes = new List<byte>(clean.Length * 5 / 8);
        int buffer = 0, bits = 0;
        foreach (var c in clean)
        {
            var v = Alphabet.IndexOf(c);
            if (v < 0) throw new FormatException("Not a Base32 string.");
            buffer = (buffer << 5) | v; bits += 5;
            if (bits >= 8) { bytes.Add((byte)((buffer >> (bits - 8)) & 0xFF)); bits -= 8; }
        }
        return [.. bytes];
    }
}
