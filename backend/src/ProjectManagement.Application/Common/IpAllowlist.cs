using System.Net;

namespace ProjectManagement.Application.Common;

/// <summary>Parses and matches the IP addresses and CIDR ranges an organization's allowlist is written in.</summary>
public static class IpAllowlist
{
    public const int MaxEntries = 200;

    /// <summary>One entry per line (blank lines and commas as separators are both accepted), de-duplicated.</summary>
    public static IReadOnlyList<string> ParseEntries(string raw) =>
        raw.Split(['\n', '\r', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    /// <summary>A bare address counts as itself only (/32 or /128); anything else must be a valid CIDR range.</summary>
    private static bool TryAsNetwork(string entry, out IPNetwork network)
    {
        var candidate = entry.Contains('/') ? entry : entry + (entry.Contains(':') ? "/128" : "/32");
        return IPNetwork.TryParse(candidate, out network);
    }

    public static bool TryValidateEntry(string entry, out string? error)
    {
        if (TryAsNetwork(entry, out _)) { error = null; return true; }
        error = $"\"{entry}\" is not a valid IP address or CIDR range (examples: 203.0.113.9, 10.0.0.0/8).";
        return false;
    }

    /// <summary>Does <paramref name="callerIp"/> fall inside any of <paramref name="entries"/>? False (never allowed) if it cannot be read.</summary>
    public static bool Matches(IReadOnlyList<string> entries, string? callerIp)
    {
        if (string.IsNullOrWhiteSpace(callerIp) || !IPAddress.TryParse(callerIp, out var addr)) return false;
        if (addr.IsIPv4MappedToIPv6) addr = addr.MapToIPv4();   // Kestrel can report IPv4 callers this way
        foreach (var entry in entries)
            if (TryAsNetwork(entry, out var network) && network.Contains(addr)) return true;
        return false;
    }
}
