using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// Web Push without third-party libraries: the payload is encrypted for the device with "aes128gcm" content encoding (RFC 8291 / RFC 8188)
/// and the request is signed with a VAPID token (RFC 8292, ES256). Push services: FCM (Chrome, Edge), Mozilla, Apple.
/// </summary>
public class WebPushSender(IHttpClientFactory http) : IWebPushSender
{
    private const int RecordSize = 4096;

    public async Task<int?> SendAsync(PushSubscription subscription, string payload, VapidKeys keys, CancellationToken ct)
    {
        var body = Encrypt(Base64Url.Decode(subscription.P256dh), Base64Url.Decode(subscription.Auth), Encoding.UTF8.GetBytes(payload));
        var endpoint = new Uri(subscription.Endpoint);
        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = new ByteArrayContent(body) };
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        req.Content.Headers.ContentEncoding.Add("aes128gcm");
        req.Headers.Add("TTL", "86400");
        req.Headers.Add("Urgency", "normal");
        req.Headers.TryAddWithoutValidation("Authorization", $"vapid t={VapidToken(endpoint, keys)}, k={keys.PublicKey}");
        using var res = await http.CreateClient("push").SendAsync(req, ct);
        return (int)res.StatusCode;
    }

    /// <summary>The message body: salt (16) | record size (4) | key id length (1) | sender public key (65) | AES-128-GCM ciphertext and tag.</summary>
    public static byte[] Encrypt(byte[] uaPublic, byte[] authSecret, byte[] plaintext)
    {
        if (plaintext.Length > RecordSize - 17 - 1) throw new ArgumentException("The push message is too long.");
        using var sender = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var sp = sender.ExportParameters(false);
        byte[] asPublic = [0x04, .. sp.Q.X!, .. sp.Q.Y!];
        using var ua = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new ECPoint { X = uaPublic[1..33], Y = uaPublic[33..65] } });
        var shared = sender.DeriveRawSecretAgreement(ua.PublicKey);

        var prkKey = HMACSHA256.HashData(authSecret, shared);
        byte[] keyInfo = [.. "WebPush: info\0"u8, .. uaPublic, .. asPublic, 0x01];
        var ikm = HMACSHA256.HashData(prkKey, keyInfo);
        var salt = RandomNumberGenerator.GetBytes(16);
        var prk = HMACSHA256.HashData(salt, ikm);
        byte[] cekInfo = [.. "Content-Encoding: aes128gcm\0"u8, 0x01], nonceInfo = [.. "Content-Encoding: nonce\0"u8, 0x01];
        var cek = HMACSHA256.HashData(prk, cekInfo)[..16];
        var nonce = HMACSHA256.HashData(prk, nonceInfo)[..12];

        byte[] padded = [.. plaintext, 0x02];   // 0x02: the last (and only) record, no padding
        var cipher = new byte[padded.Length];
        var tag = new byte[16];
        using (var aes = new AesGcm(cek, 16)) aes.Encrypt(nonce, padded, cipher, tag);
        return [.. salt, 0x00, 0x00, 0x10, 0x00, 65, .. asPublic, .. cipher, .. tag];
    }

    /// <summary>A short-lived ES256 JWT for the push service's origin, signed with the server's VAPID private key.</summary>
    public static string VapidToken(Uri endpoint, VapidKeys keys)
    {
        var header = Base64Url.Encode("""{"typ":"JWT","alg":"ES256"}"""u8);
        var exp = DateTimeOffset.UtcNow.AddHours(12).ToUnixTimeSeconds();
        var claims = Base64Url.Encode(Encoding.UTF8.GetBytes($$"""{"aud":"{{endpoint.Scheme}}://{{endpoint.Authority}}","exp":{{exp}},"sub":"{{keys.Subject}}"}"""));
        var pub = Base64Url.Decode(keys.PublicKey);
        using var ec = ECDsa.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256, D = Base64Url.Decode(keys.PrivateKey), Q = new ECPoint { X = pub[1..33], Y = pub[33..65] },
        });
        var signature = ec.SignData(Encoding.ASCII.GetBytes($"{header}.{claims}"), HashAlgorithmName.SHA256);   // IEEE P1363 (r|s), as JWS wants
        return $"{header}.{claims}.{Base64Url.Encode(signature)}";
    }
}
