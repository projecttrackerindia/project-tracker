using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using System.Text.RegularExpressions;
using ProjectManagement.Application.Features.Resumes;
using W = DocumentFormat.OpenXml.Wordprocessing;

namespace ProjectManagement.Tests;

public class ResumeTemplateRenderTests
{
    public static IEnumerable<object[]> Designs() => ResumeService.Templates.Select(t=>new object[]{t.Id});
    private static ResumeContent Content(string experience="Built a reliable delivery workflow.") => new("Template Test Owner","Software engineer","synthetic@example.test","Delivered measurable improvements.",
        [new("Core skills","C# and PostgreSQL"),new("Education","Engineering degree"),new("Professional experience",experience),new("Selected projects","Customer reporting release")]);

    [Theory]
    [MemberData(nameof(Designs))]
    public void Every_supplied_design_exports_editable_word_and_readable_pdf(int id)
    {
        var template=ResumeService.Templates.Single(t=>t.Id==id);
        var content=Content();var bytes=ResumeFiles.Pdf(content,template,true);
        using var pdf=UglyToad.PdfPig.PdfDocument.Open(bytes);var text=string.Join(" ",pdf.GetPages().Select(p=>p.Text));
        static string Compact(string value)=>Regex.Replace(value,"\\s+","");
        foreach(var fact in new[]{content.Name,content.Summary,content.Sections[0].Text,content.Sections[2].Text,"Project Tracker"})Assert.Contains(Compact(fact),Compact(text));
        Assert.DoesNotContain("[YOUR NAME]",text);
        var wordBytes=ResumeFiles.Docx(content,template,true);
        if(Environment.GetEnvironmentVariable("PM_RESUME_RENDER_ARTIFACTS") is {Length:>0} directory){Directory.CreateDirectory(directory);File.WriteAllBytes(Path.Combine(directory,$"design-{id:00}.pdf"),bytes);File.WriteAllBytes(Path.Combine(directory,$"design-{id:00}.docx"),wordBytes);}
        using var file=WordprocessingDocument.Open(new MemoryStream(wordBytes),false);
        var errors=new OpenXmlValidator().Validate(file).Take(5).Select(e=>e.Description).ToArray();Assert.True(errors.Length==0,string.Join("; ",errors));
        var body=file.MainDocumentPart!.Document.Body!;
        if(template.TwoColumn)
        {
            // Banner and sidebar designs: a banner table and a two-cell body table, in the design's banner colour.
            Assert.Equal(2,body.Elements<W.Table>().Count());Assert.Equal(2,body.Elements<W.Table>().Last().Elements<W.TableRow>().Single().Elements<W.TableCell>().Count());
            Assert.Contains(template.HeaderColor,body.InnerXml);
        }
        else
        {
            // Single-column designs: plain paragraphs (easy to edit in Word), headings in the design's colour.
            Assert.Empty(body.Elements<W.Table>());
            Assert.Contains(template.Accent,body.InnerXml);
        }
        Assert.Contains(content.Name,body.InnerText);Assert.Contains(content.Sections[0].Text,body.InnerText);Assert.Contains(content.Sections[2].Text,body.InnerText);
        Assert.Contains("Project Tracker",file.MainDocumentPart.HeaderParts.Single().Header.InnerXml);
    }

    [Fact]
    public void The_catalogue_is_twelve_distinct_designs()
    {
        Assert.Equal(12,ResumeService.Templates.Length);
        Assert.Equal(12,ResumeService.Templates.Select(t=>t.Id).Distinct().Count());
        Assert.Equal(12,ResumeService.Templates.Select(t=>t.Name).Distinct().Count());
        // Real layout variety, not recolours of one layout.
        Assert.Equal(7,ResumeService.Templates.Count(t=>!t.TwoColumn));
        Assert.True(ResumeService.Templates.Where(t=>!t.TwoColumn).Select(t=>(t.Centered,t.Rule,t.Margin,t.HeadingSize)).Distinct().Count()>=6);
    }

    [Fact]
    public void Long_column_content_paginates_without_losing_the_tail_or_overlapping_the_footer()
    {
        var experience=string.Join('\n',Enumerable.Range(1,130).Select(i=>$"Outcome {i}: delivered a measurable improvement."));
        using var pdf=UglyToad.PdfPig.PdfDocument.Open(ResumeFiles.Pdf(Content(experience),ResumeService.Templates.First(t=>t.TwoColumn),false));
        Assert.True(pdf.NumberOfPages>1);
        var text=string.Join(" ",pdf.GetPages().Select(p=>p.Text));Assert.Contains("Outcome 1:",text);Assert.Contains("Outcome 130:",text);Assert.Contains("Customer reporting release",text);
        foreach(var page in pdf.GetPages())Assert.All(page.Letters.Where(l=>l.Value!=" "),letter=>Assert.InRange(letter.GlyphRectangle.Bottom,15,842));
    }
}
