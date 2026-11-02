using System.Text;

namespace ProjectManagement.Application.Common;

public sealed class HttpBodyTooLargeException() : HttpRequestException("The response exceeds the allowed size.") { }

public static class BoundedHttpContent
{
    /// <summary>Read at most maxBytes plus one sentinel byte, including chunked responses; never buffer an unbounded body.</summary>
    public static async Task<string> ReadUtf8Async(HttpContent content, int maxBytes, CancellationToken ct)
    {
        if (maxBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maxBytes));
        if (content.Headers.ContentLength is { } length && length > maxBytes) throw new HttpBodyTooLargeException();
        await using var stream = await content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var block = new byte[Math.Min(8192, maxBytes)];
        while (true)
        {
            var read = await stream.ReadAsync(block.AsMemory(0, (int)Math.Min(block.Length, maxBytes - buffer.Length + 1)), ct);
            if (read == 0) break;
            if (buffer.Length + read > maxBytes) throw new HttpBodyTooLargeException();
            buffer.Write(block, 0, read);
        }
        return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, checked((int)buffer.Length));
    }
}
