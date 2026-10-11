namespace ProjectManagement.Application.Features.Resumes;
public record ResumeImportWorkerRequest(string FileName,string Bytes,bool RequireText);
public record ResumeImportWorkerResponse(string? Text,string? ContentType,string? Error);
public interface IResumeDocumentExtractor
{
    Task<(byte[] Bytes,string Text,string ContentType)> ExtractAsync(string name,Stream content,CancellationToken ct,bool requireText=true);
}