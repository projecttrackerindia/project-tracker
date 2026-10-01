using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>An S3-compatible bucket: AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi ... (Storage:S3:* settings).</summary>
public class S3StorageOptions
{
    public string Bucket { get; set; } = "";
    /// <summary>The endpoint for anything that is not AWS itself, e.g. https://&lt;account&gt;.r2.cloudflarestorage.com or http://localhost:9000.</summary>
    public string? ServiceUrl { get; set; }
    /// <summary>"auto" for Cloudflare R2; the bucket's region for AWS.</summary>
    public string Region { get; set; } = "us-east-1";
    public string AccessKeyId { get; set; } = "";
    public string SecretAccessKey { get; set; } = "";
    /// <summary>Path-style addresses (endpoint/bucket/key): needed by MinIO and most self-hosted stores.</summary>
    public bool ForcePathStyle { get; set; }
    /// <summary>Optional folder inside the bucket, so one bucket can serve several environments.</summary>
    public string Prefix { get; set; } = "";
}

/// <summary>
/// Files in an S3-compatible bucket, so every API server sees the same files and nothing is lost when a server is replaced. Keys are the
/// same as with local storage (tenant / month / random id). Downloads are still streamed through the API, where the permission checks are.
/// </summary>
public sealed class S3FileStorage : IFileStorage, IDisposable
{
    private readonly IAmazonS3 _s3;
    private readonly S3StorageOptions _o;
    private readonly bool _https;

    public S3FileStorage(IOptions<StorageOptions> options)
    {
        _o = options.Value.S3;
        if (string.IsNullOrWhiteSpace(_o.Bucket) || string.IsNullOrWhiteSpace(_o.AccessKeyId) || string.IsNullOrWhiteSpace(_o.SecretAccessKey))
            throw new InvalidOperationException("Storage:Provider is S3, but Storage:S3:Bucket, AccessKeyId and SecretAccessKey are not all set.");
        var config = new AmazonS3Config
        {
            ForcePathStyle = _o.ForcePathStyle,
            // Only compute and check checksums when the operation needs them: R2, MinIO and other compatible stores do not all support
            // the newer default checksum headers.
            RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
            ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
            Timeout = TimeSpan.FromSeconds(60),
        };
        if (!string.IsNullOrWhiteSpace(_o.ServiceUrl)) { config.ServiceURL = _o.ServiceUrl; config.AuthenticationRegion = _o.Region; }
        else config.RegionEndpoint = Amazon.RegionEndpoint.GetBySystemName(_o.Region);
        _https = string.IsNullOrWhiteSpace(_o.ServiceUrl) || _o.ServiceUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
        _s3 = new AmazonS3Client(new BasicAWSCredentials(_o.AccessKeyId, _o.SecretAccessKey), config);
    }

    public string Name => "s3";

    private string KeyFor(string key)
    {
        if (string.IsNullOrWhiteSpace(key) || key.Contains("..") || key.StartsWith('/')) throw new ArgumentException("Invalid storage key.", nameof(key));
        var prefix = _o.Prefix.Trim('/');
        return prefix.Length == 0 ? key : $"{prefix}/{key}";
    }

    public async Task SaveAsync(string key, Stream content, CancellationToken ct = default)
    {
        // The SDK needs to know the length up front: buffer streams that cannot tell it (they are small, uploads are size-limited).
        Stream body = content;
        MemoryStream? buffer = null;
        if (!content.CanSeek)
        {
            buffer = new MemoryStream();
            await content.CopyToAsync(buffer, ct);
            buffer.Position = 0;
            body = buffer;
        }
        try
        {
            await _s3.PutObjectAsync(new PutObjectRequest
            {
                BucketName = _o.Bucket, Key = KeyFor(key), InputStream = body, AutoCloseStream = false,
                // Over HTTPS the transport already protects the body; skipping payload signing is what R2 recommends.
                DisablePayloadSigning = _https,
            }, ct);
        }
        finally { buffer?.Dispose(); }
    }

    public async Task<Stream?> OpenReadAsync(string key, CancellationToken ct = default)
    {
        try
        {
            var response = await _s3.GetObjectAsync(new GetObjectRequest { BucketName = _o.Bucket, Key = KeyFor(key) }, ct);
            return new OwnedStream(response.ResponseStream, response);
        }
        catch (AmazonS3Exception e) when (e.StatusCode == System.Net.HttpStatusCode.NotFound) { return null; }
    }

    public Task DeleteAsync(string key, CancellationToken ct = default) =>
        _s3.DeleteObjectAsync(new DeleteObjectRequest { BucketName = _o.Bucket, Key = KeyFor(key) }, ct);

    public async Task<bool> ExistsAsync(string key, CancellationToken ct = default)
    {
        try { await _s3.GetObjectMetadataAsync(new GetObjectMetadataRequest { BucketName = _o.Bucket, Key = KeyFor(key) }, ct); return true; }
        catch (AmazonS3Exception e) when (e.StatusCode == System.Net.HttpStatusCode.NotFound) { return false; }
    }

    public void Dispose() => _s3.Dispose();

    /// <summary>The object's body, which also releases the response it came with when the caller is done reading.</summary>
    private sealed class OwnedStream(Stream inner, IDisposable owner) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) => inner.ReadAsync(buffer, offset, count, ct);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) => inner.ReadAsync(buffer, ct);
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) { inner.Dispose(); owner.Dispose(); } base.Dispose(disposing); }
    }
}

/// <summary>
/// After switching from local disk to a bucket: copies the files still on this server's disk into the bucket once, skipping any that are
/// already there, so nothing uploaded before the switch goes missing. The local copies are left in place (delete them once satisfied).
/// </summary>
public class StorageMigrationWorker(IFileStorage storage, IOptions<StorageOptions> options, ILogger<StorageMigrationWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var o = options.Value;
        if (storage.Name != "s3" || !o.MigrateLocal) return;
        var root = Path.GetFullPath(o.LocalPath);
        if (!Directory.Exists(root)) return;
        int copied = 0, present = 0, failed = 0;
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            if (stop.IsCancellationRequested) break;
            if (file.EndsWith(".part", StringComparison.Ordinal)) continue;
            var key = Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/');
            try
            {
                if (await storage.ExistsAsync(key, stop)) { present++; continue; }
                await using var read = File.OpenRead(file);
                await storage.SaveAsync(key, read, stop);
                copied++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { failed++; log.LogWarning(ex, "Could not copy {Key} to the bucket", key); }
        }
        if (copied + failed > 0 || present > 0)
            log.LogInformation("Local files copied to the bucket: {Copied} copied, {Present} already there, {Failed} failed", copied, present, failed);
    }
}
