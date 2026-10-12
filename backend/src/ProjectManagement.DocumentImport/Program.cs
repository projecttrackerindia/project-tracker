using System.Text;
using System.Text.Json;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Resumes;

// Private stdin/stdout protocol only. No host/configuration, database, network clients or inherited credentials.
var json=new JsonSerializerOptions(JsonSerializerDefaults.Web);
try
{
    var buffer=new char[8192];var input=new StringBuilder();int count;
    while((count=await Console.In.ReadAsync(buffer))>0)
    {
        if(input.Length+count>3*1024*1024)throw new ValidationException("file","Keep document uploads under 2 MB.");
        input.Append(buffer,0,count);
    }
    var request=JsonSerializer.Deserialize<ResumeImportWorkerRequest>(input.ToString(),json)??throw new InvalidDataException();
    var bytes=Convert.FromBase64String(request.Bytes);
    if(bytes.Length>ResumeFiles.MaxBytes)throw new ValidationException("file","Keep document uploads under 2 MB.");
    var extension=Path.GetExtension(request.FileName).ToLowerInvariant();
    if(extension is ".png" or ".jpg" or ".jpeg")
    {
        if(request.RequireText)throw new ValidationException("file","Resume imports require a text-based PDF or DOCX.");
        var type=PdfImage.Kind(bytes)??throw new ValidationException("file","Use a valid PNG or JPEG certificate.");
        try{PdfImage.Read(bytes);}catch(FormatException){throw new ValidationException("file","This certificate image could not be read.");}
        await Console.Out.WriteAsync(JsonSerializer.Serialize(new ResumeImportWorkerResponse("",type,null),json));return 0;
    }
    using var stream=new MemoryStream(bytes);
    var result=await ResumeFiles.ExtractAsync(request.FileName,stream,CancellationToken.None,request.RequireText);
    await Console.Out.WriteAsync(JsonSerializer.Serialize(new ResumeImportWorkerResponse(result.Text,result.ContentType,null),json));
    return 0;
}
catch(Exception ex)
{
    var error=ex is ValidationException?ex.Message:"This document could not be read. Upload a fresh text-based PDF or DOCX.";
    await Console.Out.WriteAsync(JsonSerializer.Serialize(new ResumeImportWorkerResponse(null,null,error),json));
    return 3;
}