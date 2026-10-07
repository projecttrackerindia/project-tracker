using System.IO.Compression;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>A picture ready to place in a PDF: JPEG data is passed through; PNG is decoded to plain samples (with a separate transparency mask) so any PNG viewers accept can be printed.</summary>
public sealed class PdfImage
{
    public int Width { get; init; }
    public int Height { get; init; }
    public string ColorSpace { get; init; } = "/DeviceRGB";
    public string Filter { get; init; } = "/FlateDecode";
    public byte[] Data { get; init; } = [];
    public byte[]? Alpha { get; init; }   // deflated 8-bit mask
    public bool Cmyk { get; init; }

    public const int MaxPixels = 16_000_000;

    public static string? Kind(ReadOnlySpan<byte> b) =>
        b.Length > 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G' ? "image/png" : b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF ? "image/jpeg" : null;

    /// <summary>Reads a PNG or JPEG. Throws <see cref="FormatException"/> with a message fit for a person when the picture cannot be used.</summary>
    public static PdfImage Read(byte[] bytes)
    {
        return Kind(bytes) switch
        {
            "image/png" => ReadPng(bytes),
            "image/jpeg" => ReadJpeg(bytes),
            _ => throw new FormatException("Use a PNG or JPEG picture."),
        };
    }

    private static PdfImage ReadJpeg(byte[] b)
    {
        var i = 2;
        while (i + 9 < b.Length)
        {
            if (b[i] != 0xFF) { i++; continue; }
            var marker = b[i + 1];
            if (marker is 0xD8 or 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
            var len = (b[i + 2] << 8) | b[i + 3];
            if (marker is 0xC0 or 0xC1 or 0xC2)
            {
                var h = (b[i + 5] << 8) | b[i + 6]; var w = (b[i + 7] << 8) | b[i + 8]; var comps = b[i + 9];
                if (w <= 0 || h <= 0 || (long)w * h > MaxPixels) throw new FormatException("That picture is too large (up to 16 megapixels).");
                if (comps is not (1 or 3 or 4)) throw new FormatException("That JPEG uses colours that cannot be printed.");
                return new PdfImage { Width = w, Height = h, Filter = "/DCTDecode", ColorSpace = comps == 1 ? "/DeviceGray" : comps == 3 ? "/DeviceRGB" : "/DeviceCMYK", Data = b, Cmyk = comps == 4 };
            }
            i += 2 + len;
        }
        throw new FormatException("That JPEG could not be read.");
    }

    private static PdfImage ReadPng(byte[] b)
    {
        int w = 0, h = 0, depth = 0, color = 0, interlace = 0; byte[]? palette = null; byte[]? trns = null;
        using var idat = new MemoryStream();
        var p = 8;
        while (p + 8 <= b.Length)
        {
            var len = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
            var type = System.Text.Encoding.ASCII.GetString(b, p + 4, 4);
            if (len < 0 || p + 12 + len > b.Length) throw new FormatException("That PNG is damaged.");
            switch (type)
            {
                case "IHDR": w = (b[p + 8] << 24) | (b[p + 9] << 16) | (b[p + 10] << 8) | b[p + 11]; h = (b[p + 12] << 24) | (b[p + 13] << 16) | (b[p + 14] << 8) | b[p + 15]; depth = b[p + 16]; color = b[p + 17]; interlace = b[p + 20]; break;
                case "PLTE": palette = b[(p + 8)..(p + 8 + len)]; break;
                case "tRNS": trns = b[(p + 8)..(p + 8 + len)]; break;
                case "IDAT": idat.Write(b, p + 8, len); break;
            }
            if (type == "IEND") break;
            p += 12 + len;
        }
        if (w <= 0 || h <= 0 || (long)w * h > MaxPixels) throw new FormatException("That picture is too large (up to 16 megapixels).");
        if (depth != 8 || interlace != 0) throw new FormatException("Save the PNG as a standard 8-bit, non-interlaced picture.");
        var channels = color switch { 0 => 1, 2 => 3, 3 => 1, 4 => 2, 6 => 4, _ => throw new FormatException("That PNG uses a format that cannot be printed.") };
        if (color == 3 && palette is null) throw new FormatException("That PNG is damaged.");

        idat.Position = 0;
        var raw = new byte[h * (1 + w * channels)];
        try { using var z = new ZLibStream(idat, CompressionMode.Decompress); z.ReadExactly(raw); }
        catch (Exception e) when (e is InvalidDataException or EndOfStreamException) { throw new FormatException("That PNG is damaged."); }

        // Undo the per-row filters.
        var stride = w * channels; var px = new byte[h * stride];
        for (var y = 0; y < h; y++)
        {
            var f = raw[y * (stride + 1)]; var src = y * (stride + 1) + 1; var dst = y * stride;
            for (var x = 0; x < stride; x++)
            {
                int a = x >= channels ? px[dst + x - channels] : 0, up = y > 0 ? px[dst - stride + x] : 0, c = x >= channels && y > 0 ? px[dst - stride + x - channels] : 0;
                int v = raw[src + x];
                v += f switch { 0 => 0, 1 => a, 2 => up, 3 => (a + up) / 2, 4 => Paeth(a, up, c), _ => throw new FormatException("That PNG is damaged.") };
                px[dst + x] = (byte)v;
            }
        }

        byte[] rgb; byte[]? alpha = null; string space;
        if (color == 0) { rgb = px; space = "/DeviceGray"; }
        else if (color == 2) { rgb = px; space = "/DeviceRGB"; }
        else if (color == 3)
        {
            rgb = new byte[w * h * 3]; space = "/DeviceRGB";
            var a8 = trns is null ? null : new byte[w * h];
            for (var i = 0; i < w * h; i++)
            {
                var idx = px[i]; rgb[i * 3] = palette![idx * 3]; rgb[i * 3 + 1] = palette[idx * 3 + 1]; rgb[i * 3 + 2] = palette[idx * 3 + 2];
                if (a8 is not null) a8[i] = idx < trns!.Length ? trns[idx] : (byte)255;
            }
            if (a8 is not null) alpha = a8;
        }
        else if (color == 4)
        {
            rgb = new byte[w * h]; alpha = new byte[w * h]; space = "/DeviceGray";
            for (var i = 0; i < w * h; i++) { rgb[i] = px[i * 2]; alpha[i] = px[i * 2 + 1]; }
        }
        else
        {
            rgb = new byte[w * h * 3]; alpha = new byte[w * h]; space = "/DeviceRGB";
            for (var i = 0; i < w * h; i++) { rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2]; alpha[i] = px[i * 4 + 3]; }
        }
        if (alpha is not null && alpha.All(a => a == 255)) alpha = null;
        return new PdfImage { Width = w, Height = h, ColorSpace = space, Data = Deflate(rgb), Alpha = alpha is null ? null : Deflate(alpha) };
    }

    private static int Paeth(int a, int b, int c)
    {
        var p = a + b - c; var pa = Math.Abs(p - a); var pb = Math.Abs(p - b); var pc = Math.Abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }

    private static byte[] Deflate(byte[] data)
    {
        using var ms = new MemoryStream();
        using (var z = new ZLibStream(ms, CompressionLevel.Optimal, true)) z.Write(data);
        return ms.ToArray();
    }
}
