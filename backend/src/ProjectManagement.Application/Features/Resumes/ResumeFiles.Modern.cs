using System.Text;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using PdfSharp.Drawing;
using ProjectManagement.Application.Exceptions;
using W = DocumentFormat.OpenXml.Wordprocessing;

namespace ProjectManagement.Application.Features.Resumes;

public static partial class ResumeFiles
{
    internal static bool SidebarSection(ResumeSection section) => section.Heading.Trim().ToLowerInvariant() is
        "skills" or "core skills" or "technical skills" or "education" or "certification" or "certifications" or "languages";

    private static XColor Color(string hex) => XColor.FromArgb(Convert.ToInt32(hex[..2],16),Convert.ToInt32(hex.Substring(2,2),16),Convert.ToInt32(hex.Substring(4,2),16));
    private sealed record DocumentLine(string Text, XFont Font, XBrush Brush, bool Heading = false, double Gap = 0);

    private static byte[] ModernPdf(ResumeContent content, ResumeTemplate template, bool watermark)
    {
        Fonts(); using var document = new PdfSharp.Pdf.PdfDocument(); document.Info.Title="Resume"; document.Info.Creator="Project Tracker";
        document.RenderEvents.RenderTextEvent+=(_,args)=>{
            if(args.CodePointGlyphIndexPairs.Any(pair=>pair.GlyphIndex==0 && !Rune.IsWhiteSpace(new Rune(pair.CodePoint))))
                throw new ValidationException("content","Some characters are not supported by the PDF font. Download Word to preserve this text.");
        };
        var bodyFont=new XFont("PT Noto",9.5,XFontStyleEx.Regular);
        var headingFont=new XFont("PT Noto",10.5,XFontStyleEx.Bold);
        var nameFont=new XFont("PT Noto",26,XFontStyleEx.Bold);
        var subtitleFont=new XFont("PT Noto",10.5,XFontStyleEx.Bold);
        var contactFont=new XFont("PT Noto",9,XFontStyleEx.Regular);
        var bodyBrush=new XSolidBrush(Color("28354A")); var headingBrush=new XSolidBrush(Color(template.HeadingColor));
        var width=595-template.Margin*2; var sideWidth=width*.29; var gap=22d; var mainWidth=width-sideWidth-gap;
        // Measure with the same font metrics that draw the export; long tokens are split at Unicode rune boundaries.
        var first=document.AddPage(); first.Width=XUnit.FromPoint(595); first.Height=XUnit.FromPoint(842);
        using var measure=XGraphics.FromPdfPage(first);
        List<string> Wrap(string text,XFont font,double available)
        {
            var result=new List<string>();
            foreach(var paragraph in text.Replace("\r","").Split('\n'))
            {
                var line="";
                foreach(var word in paragraph.Split(' ',StringSplitOptions.RemoveEmptyEntries))
                {
                    var candidate=line.Length==0?word:line+" "+word;
                    if(line.Length>0 && measure.MeasureString(candidate,font).Width>available){result.Add(line);line="";}
                    var remainder=word;
                    if(line.Length>0){line+=" "+word;continue;}
                    while(measure.MeasureString(remainder,font).Width>available)
                    {
                        var take=0;
                        foreach(var rune in remainder.EnumerateRunes())
                        {
                            var next=take+rune.Utf16SequenceLength;
                            if(take>0 && measure.MeasureString(remainder[..next],font).Width>available)break;
                            take=next;
                        }
                        result.Add(remainder[..take]);remainder=remainder[take..];
                    }
                    line=remainder;
                }
                result.Add(line);
            }
            return result;
        }
        List<DocumentLine> Flow(IEnumerable<ResumeSection> sections,double available)
        {
            var result=new List<DocumentLine>();
            foreach(var section in sections.Where(s=>!string.IsNullOrWhiteSpace(s.Text)))
            {
                foreach(var text in Wrap(section.Heading.ToUpperInvariant(),headingFont,available))result.Add(new(text,headingFont,headingBrush,true,4));
                foreach(var text in Wrap(section.Text,bodyFont,available))result.Add(new(text,bodyFont,bodyBrush));
                result.Add(new("",bodyFont,bodyBrush,false,8));
            }
            return result;
        }
        var left=Flow(new[]{new ResumeSection("Profile",content.Summary)}.Concat(content.Sections.Where(SidebarSection)),sideWidth);
        var right=Flow(content.Sections.Where(s=>!SidebarSection(s)),mainWidth);
        var name=Wrap(content.Name,nameFont,width-24);
        var subtitle=string.IsNullOrWhiteSpace(content.Headline)?[]:Wrap(content.Headline,subtitleFont,width-24);
        var contact=string.IsNullOrWhiteSpace(content.Contact)?[]:Wrap(content.Contact,contactFont,width-24);
        // Dispose the measuring graphics before drawing the same first page.
        measure.Dispose();
        int li=0,ri=0,pageNumber=0;
        do
        {
            if(++pageNumber>30)throw new ValidationException("content","This resume is too long to export.");
            var page=pageNumber==1?first:document.AddPage(); page.Width=XUnit.FromPoint(595);page.Height=XUnit.FromPoint(842);
            using var graphics=XGraphics.FromPdfPage(page);
            if(watermark)graphics.DrawString("Project Tracker",new XFont("PT Noto",58,XFontStyleEx.Bold),new XSolidBrush(Color("F2EDFF")),new XRect(0,375,595,90),XStringFormats.Center);
            var bannerHeight=pageNumber==1?24+name.Count*31+subtitle.Count*15+contact.Count*13:44;
            graphics.DrawRectangle(new XSolidBrush(Color(template.HeaderColor)),template.Margin,template.Margin,width,bannerHeight);
            var y=template.Margin+10;
            if(pageNumber==1)
            {
                foreach(var text in name){graphics.DrawString(text,nameFont,new XSolidBrush(Color(template.HeaderText)),new XRect(template.Margin+12,y,width-24,31),XStringFormats.TopCenter);y+=31;}
                foreach(var text in subtitle){graphics.DrawString(text,subtitleFont,new XSolidBrush(Color(template.BannerAccent)),new XRect(template.Margin+12,y,width-24,15),XStringFormats.TopLeft);y+=15;}
                foreach(var text in contact){graphics.DrawString(text,contactFont,new XSolidBrush(Color(template.HeaderText)),new XRect(template.Margin+12,y,width-24,13),XStringFormats.TopLeft);y+=13;}
            }
            else graphics.DrawString(content.Name,new XFont("PT Noto",12,XFontStyleEx.Bold),new XSolidBrush(Color(template.HeaderText)),new XRect(template.Margin+12,y,width-24,24),XStringFormats.TopLeft);
            double top=template.Margin+bannerHeight+20;
            double DrawColumn(List<DocumentLine> lines,ref int index,double x,double available)
            {
                var cursor=top;
                while(index<lines.Count)
                {
                    var line=lines[index];var h=line.Font.Size*1.45+line.Gap;
                    if(cursor+h+(line.Heading?bodyFont.Size*1.45:0)>785)break;
                    if(line.Text.Length>0)graphics.DrawString(line.Text,line.Font,line.Brush,new XRect(x,cursor,available,line.Font.Size*1.45),XStringFormats.TopLeft);
                    cursor+=h;index++;
                }
                return cursor;
            }
            var bottom=Math.Max(DrawColumn(left,ref li,template.Margin,sideWidth),DrawColumn(right,ref ri,template.Margin+sideWidth+gap,mainWidth));
            graphics.DrawLine(new XPen(Color(template.Accent),.75),template.Margin+sideWidth+gap/2,top,template.Margin+sideWidth+gap/2,Math.Max(top+20,bottom));
            graphics.DrawString(pageNumber.ToString(),new XFont("PT Noto",8),XBrushes.Gray,new XRect(template.Margin,810,width,12),XStringFormats.TopRight);
        }while(li<left.Count || ri<right.Count);
        using var output=new MemoryStream(); document.Save(output,false); return output.ToArray();
    }

    private static byte[] ModernDocx(ResumeContent content,ResumeTemplate template,bool watermark)
    {
        // Preserve the existing tested watermark/header and section properties; only replace the document's editable body.
        var legacy=Docx(content,template with{TwoColumn=false},watermark);
        using var output=new MemoryStream(); output.Write(legacy); output.Position=0;
        using(var document=WordprocessingDocument.Open(output,true))
        {
            var main=document.MainDocumentPart!; var body=main.Document.Body!;
            var properties=body.Elements<W.SectionProperties>().Single().CloneNode(true);body.RemoveAllChildren();
            W.Paragraph Paragraph(string text,int size=19,bool bold=false,string color="28354A",bool centered=false,bool heading=false)
            {
                var pp=new W.ParagraphProperties(); if(heading)pp.Append(new W.KeepNext());pp.Append(new W.WidowControl());
                pp.Append(new W.SpacingBetweenLines{Before=heading?"160":"0",After=heading?"70":"90"});
                if(centered)pp.Append(new W.Justification{Val=W.JustificationValues.Center});
                var rp=new W.RunProperties(new W.RunFonts{Ascii="Aptos",HighAnsi="Aptos"});if(bold)rp.Append(new W.Bold());
                rp.Append(new W.Color{Val=color},new W.FontSize{Val=size.ToString()});var run=new W.Run(rp);
                var lines=text.Replace("\r","").Split('\n');for(var i=0;i<lines.Length;i++){if(i>0)run.Append(new W.Break());run.Append(new W.Text(lines[i]){Space=SpaceProcessingModeValues.Preserve});}
                return new W.Paragraph(pp,run);
            }
            W.Table Table(params int[] widths)
            {
                var table=new W.Table(new W.TableProperties(new W.TableWidth{Width="5000",Type=W.TableWidthUnitValues.Pct},new W.TableLayout{Type=W.TableLayoutValues.Fixed}));
                var grid=new W.TableGrid();foreach(var width in widths)grid.Append(new W.GridColumn{Width=width.ToString()});table.Append(grid);return table;
            }
            var total=(595-template.Margin*2)*20;
            var banner=Table(total); var bannerCell=new W.TableCell(new W.TableCellProperties(new W.TableCellWidth{Width=total.ToString(),Type=W.TableWidthUnitValues.Dxa},new W.Shading{Val=W.ShadingPatternValues.Clear,Fill=template.HeaderColor}));
            bannerCell.Append(Paragraph(content.Name,52,true,template.HeaderText,true));
            if(content.Headline.Length>0)bannerCell.Append(Paragraph(content.Headline,21,true,template.BannerAccent));
            if(content.Contact.Length>0)bannerCell.Append(Paragraph(content.Contact,18,false,template.HeaderText));
            banner.Append(new W.TableRow(bannerCell));body.Append(banner,new W.Paragraph());
            var side=(int)(total*.31);var columns=Table(side,total-side);
            var left=new W.TableCell(new W.TableCellProperties(new W.TableCellWidth{Width=side.ToString(),Type=W.TableWidthUnitValues.Dxa},new W.TableCellBorders(new W.RightBorder{Val=W.BorderValues.Single,Color=template.Accent,Size=6})));
            var right=new W.TableCell(new W.TableCellProperties(new W.TableCellWidth{Width=(total-side).ToString(),Type=W.TableWidthUnitValues.Dxa}));
            void Sections(W.TableCell cell,IEnumerable<ResumeSection> sections)
            {
                foreach(var section in sections.Where(s=>!string.IsNullOrWhiteSpace(s.Text)))cell.Append(Paragraph(section.Heading.ToUpperInvariant(),21,true,template.HeadingColor,heading:true),Paragraph(section.Text));
                if(!cell.Elements<W.Paragraph>().Any())cell.Append(new W.Paragraph());
            }
            Sections(left,new[]{new ResumeSection("Profile",content.Summary)}.Concat(content.Sections.Where(SidebarSection)));
            Sections(right,content.Sections.Where(s=>!SidebarSection(s)));columns.Append(new W.TableRow(left,right));body.Append(columns,properties);main.Document.Save();
        }
        return output.ToArray();
    }
}
