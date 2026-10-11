using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Resumes;
namespace ProjectManagement.Tests;

[Collection("api")]
public class DocumentExportSafetyTests
{
    [Fact]
    public void Pdf_does_not_silently_replace_characters_missing_from_the_embedded_font()
    {
        var content=new ResumeContent("தமிழ்","","","Self supplied content",[]);
        var error=Assert.Throws<ValidationException>(()=>ResumeFiles.Pdf(content,ResumeService.Templates[0],false));
        Assert.Contains("Download Word",error.Message);
        using var document=WordprocessingDocument.Open(new MemoryStream(ResumeFiles.Docx(content,ResumeService.Templates[0],false)),false);
        Assert.Contains("தமிழ்",document.MainDocumentPart!.Document.InnerText);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Word_exports_have_valid_document_structure(bool watermark)
    {
        var bytes=ResumeFiles.Docx(new("Résumé owner","Engineer","Contact","Approved profile",[new("Experience","Completed work.")]),ResumeService.Templates[0],watermark);
        using var document=WordprocessingDocument.Open(new MemoryStream(bytes),false);
        var errors=new OpenXmlValidator().Validate(document).Select(e=>e.Description+" at "+e.Path?.XPath).ToArray();
        Assert.True(errors.Length==0,string.Join("\n",errors));
    }
}