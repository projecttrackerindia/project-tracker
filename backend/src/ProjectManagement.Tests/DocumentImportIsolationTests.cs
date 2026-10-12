using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Text;
using ProjectManagement.Application.Features.Resumes;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;

[Collection("api")]
public class DocumentImportIsolationTests(ApiFactory factory)
{
    [Fact]
    public async Task Highly_compressed_pdf_cannot_exhaust_the_api_and_a_following_import_still_succeeds()
    {
        var user=await TestClient.RegisterAsync(factory,"Import isolation");
        using var compressed=new MemoryStream();
        using(var zlib=new ZLibStream(compressed,CompressionLevel.SmallestSize,true))
        {
            var block=Encoding.ASCII.GetBytes(new string(' ',32768));
            // Over the parser process's 128 MiB managed-heap budget; never allocate this expanded input in the API or test host.
            for(var i=0;i<8192;i++)zlib.Write(block);
        }
        using var pdf=new MemoryStream();var offsets=new List<long>{0};
        void Write(string text)=>pdf.Write(Encoding.ASCII.GetBytes(text));
        void Object(int number,string content){offsets.Add(pdf.Position);Write($"{number} 0 obj\n{content}\nendobj\n");}
        Write("%PDF-1.4\n");Object(1,"<< /Type /Catalog /Pages 2 0 R >>");Object(2,"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        Object(3,"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>");
        offsets.Add(pdf.Position);Write($"4 0 obj\n<< /Length {compressed.Length} /Filter /FlateDecode >>\nstream\n");pdf.Write(compressed.ToArray());Write("\nendstream\nendobj\n");
        var xref=pdf.Position;Write("xref\n0 5\n0000000000 65535 f \n");foreach(var offset in offsets.Skip(1))Write($"{offset:D10} 00000 n \n");
        Write($"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        Assert.True(pdf.Length<ResumeFiles.MaxBytes);
        var timer=Stopwatch.StartNew();var rejected=await user.Upload("/api/v1/me/resumes/import","compressed.pdf",pdf.ToArray());
        Assert.Equal(HttpStatusCode.UnprocessableEntity,rejected.Status);Assert.True(timer.Elapsed<TimeSpan.FromSeconds(20));
        var good=ResumeFiles.Docx(new("Import isolation","Engineer","","Valid supplied content",[]),ResumeService.Templates[0],false);
        var imported=await user.Upload("/api/v1/me/resumes/import","valid.docx",good);Assert.True(imported.Ok,imported.ToString());
        var id=imported.Data!["id"]!.GetValue<string>();
        using var original=await user.Raw($"/api/v1/me/resumes/{id}/versions/1/original");Assert.Equal(good,await original.Content.ReadAsByteArrayAsync());
        Assert.True((await user.Delete($"/api/v1/me/resumes/{id}/versions/1/original")).Ok);
        Assert.Equal(HttpStatusCode.NotFound,(await user.Raw($"/api/v1/me/resumes/{id}/versions/1/original")).StatusCode);
    }
}