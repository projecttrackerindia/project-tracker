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

    public static IEnumerable<object[]> Styles => ResumeService.Templates.SelectMany(t=>new[]{new object[]{t.Id,true},new object[]{t.Id,false}});
    [Theory]
    [MemberData(nameof(Styles))]
    public void Word_exports_have_valid_document_structure(int templateId,bool watermark)
    {
        var bytes=ResumeFiles.Docx(new("Résumé owner","Engineer","Contact","Approved profile",[new("Experience","Completed work.")]),ResumeService.Templates.Single(t=>t.Id==templateId),watermark);
        using var document=WordprocessingDocument.Open(new MemoryStream(bytes),false);
        var errors=new OpenXmlValidator().Validate(document).Select(e=>e.Description+" at "+e.Path?.XPath).ToArray();
        Assert.True(errors.Length==0,string.Join("\n",errors));
        Assert.Contains("Completed work.",document.MainDocumentPart!.Document.InnerText);
        Assert.DoesNotContain("Project Tracker",document.MainDocumentPart.Document.InnerText);
        Assert.Equal(watermark,document.MainDocumentPart.HeaderParts.Any());
        if(watermark)
        {
            var header=document.MainDocumentPart.HeaderParts.Single().Header!;
            Assert.Single(header.Descendants<DocumentFormat.OpenXml.Vml.TextPath>().Where(x=>x.String?.Value=="Project Tracker"));
            var shape=Assert.Single(header.Descendants<DocumentFormat.OpenXml.Vml.Shape>());
            Assert.Contains(header.Descendants<DocumentFormat.OpenXml.Vml.Shapetype>(),x=>"#"+x.Id?.Value==shape.Type?.Value);
        }
        var artifacts=Environment.GetEnvironmentVariable("PM_TEST_RESUME_ARTIFACTS");
        if(!string.IsNullOrEmpty(artifacts))
        {
            Directory.CreateDirectory(artifacts);
            File.WriteAllBytes(Path.Combine(artifacts,$"style-{templateId}-{(watermark?"branded":"clean")}.docx"),bytes);
        }
    }
}