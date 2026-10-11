using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Resumes;
namespace ProjectManagement.Infrastructure.Services;

public class ResumeImportOptions
{
    public const string Section="Resume:Imports";
    public string WorkerPath {get;set;}=Path.Combine(AppContext.BaseDirectory,"document-import","ProjectManagement.DocumentImport.dll");
    public int TimeoutSeconds {get;set;}=10;
}
public class IsolatedResumeDocumentExtractor(IOptions<ResumeImportOptions> options):IResumeDocumentExtractor
{
    private static readonly SemaphoreSlim Slots=new(2,2);
    private static readonly JsonSerializerOptions Json=new(JsonSerializerDefaults.Web);
    public async Task<(byte[] Bytes,string Text,string ContentType)> ExtractAsync(string name,Stream content,CancellationToken ct,bool requireText=true)
    {
        var extension=Path.GetExtension(name).ToLowerInvariant();
        if(extension is not (".pdf" or ".docx") && (requireText || extension is not (".png" or ".jpg" or ".jpeg")))throw new ValidationException("file","Use a PDF or DOCX, up to 2 MB.");
        if(!File.Exists(options.Value.WorkerPath))throw new AppException(503,"DOCUMENT_IMPORT_UNAVAILABLE","Document import is temporarily unavailable. You can continue editing manually.");
        // Acquire admission before copying upload bytes into managed memory.
        if(!await Slots.WaitAsync(TimeSpan.FromSeconds(2),ct))throw new AppException(503,"DOCUMENT_IMPORT_BUSY","Documents are currently being processed. Try importing again shortly; manual editing remains available.");
        try
        {
            using var input=new MemoryStream();var chunk=new byte[81920];int n;
            while((n=await content.ReadAsync(chunk,ct))>0)
            {
                if(input.Length+n>ResumeFiles.MaxBytes)throw new ValidationException("file","Keep document uploads under 2 MB.");
                input.Write(chunk,0,n);
            }
            var bytes=input.ToArray();
            if(bytes.Length<8)throw new ValidationException("file","This document is empty or incomplete.");
            using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(options.Value.TimeoutSeconds,2,30)));
            var start=new ProcessStartInfo("dotnet"){UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true};
            start.ArgumentList.Add(Path.GetFullPath(options.Value.WorkerPath));
            start.Environment.Clear();
            foreach(var key in new[]{"PATH","SystemRoot","WINDIR","TEMP","TMP","TMPDIR"})
                if(Environment.GetEnvironmentVariable(key) is {} value)start.Environment[key]=value;
            // .NET reads this value as hexadecimal bytes: 128 MiB per parser process.
            start.Environment["DOTNET_GCHeapHardLimit"]="08000000";
            start.Environment["DOTNET_GCConserveMemory"]="9";
            start.Environment["DOTNET_EnableDiagnostics"]="0";
            using var process=new Process{StartInfo=start};
            Task<string>? output=null; Task? errors=null;
            try
            {
                if(!process.Start())throw new InvalidOperationException();
                output=ReadBoundedAsync(process.StandardOutput,300000,deadline.Token);
                errors=DrainErrorsAsync(process.StandardError,deadline.Token);
                var payload=JsonSerializer.Serialize(new ResumeImportWorkerRequest("document"+extension,Convert.ToBase64String(bytes),requireText),Json);
                await process.StandardInput.WriteAsync(payload.AsMemory(),deadline.Token);process.StandardInput.Close();
                await process.WaitForExitAsync(deadline.Token);
                var response=JsonSerializer.Deserialize<ResumeImportWorkerResponse>(await output,Json);
                await errors;
                if(response?.Error is {} error)throw new ValidationException("file",error);
                var type=extension switch{".pdf"=>"application/pdf",".docx"=>"application/vnd.openxmlformats-officedocument.wordprocessingml.document",".png"=>"image/png",_=>"image/jpeg"};
                if(process.ExitCode!=0||response?.Text is null||response.ContentType!=type||response.Text.Length>40000)
                    throw new ValidationException("file","This document could not be read within the import limits. Use a fresh text-based PDF or DOCX.");
                return(bytes,response.Text,type);
            }
            catch(OperationCanceledException)when(!ct.IsCancellationRequested)
            {throw new ValidationException("file","This document took too long to read. Use a fresh text-based PDF or DOCX.");}
            catch(Exception ex)when(ex is not AppException and not OperationCanceledException)
            {throw new ValidationException("file","This document could not be processed. Use a fresh text-based PDF or DOCX.");}
            finally
            {
                try{if(!process.HasExited)process.Kill(entireProcessTree:true);}catch(Exception ex)when(ex is InvalidOperationException or System.ComponentModel.Win32Exception){}
                deadline.Cancel();
                // Readers may fail or be canceled when a parser is killed. Observe both tasks.
                if(output is not null)try{await output;}catch(Exception){}
                if(errors is not null)try{await errors;}catch(Exception){}
            }
        }
        finally{Slots.Release();}
    }
    private static async Task<string> ReadBoundedAsync(StreamReader reader,int limit,CancellationToken ct)
    {
        var output=new StringBuilder();var buffer=new char[8192];int count;
        while((count=await reader.ReadAsync(buffer.AsMemory(),ct))>0)
        {if(output.Length+count>limit)throw new InvalidDataException();output.Append(buffer,0,count);}
        return output.ToString();
    }
    private static async Task DrainErrorsAsync(StreamReader reader,CancellationToken ct)
    {
        var buffer=new char[4096];while(await reader.ReadAsync(buffer.AsMemory(),ct)>0){}
        // Never log parser stderr: malformed documents must not disclose personal text or internal paths.
    }
}