using System.IO.Compression;
using System.Text;
using System.Xml;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using W = DocumentFormat.OpenXml.Wordprocessing;
using PdfSharp.Drawing;
using PdfSharp.Fonts;
using ProjectManagement.Application.Exceptions;
namespace ProjectManagement.Application.Features.Resumes;

public static class ResumeFiles
{
    public const int MaxBytes = 2 * 1024 * 1024;
    public static async Task<(byte[] Bytes,string Text,string ContentType)> ExtractAsync(string name,Stream content,CancellationToken ct,bool requireText=true)
    {
        var ext=Path.GetExtension(name).ToLowerInvariant();
        if(ext is not (".pdf" or ".docx"))throw new ValidationException("file","Upload a PDF or DOCX resume, up to 2 MB.");
        using var buffer=new MemoryStream();var chunk=new byte[81920];int n;
        while((n=await content.ReadAsync(chunk,ct))>0){if(buffer.Length+n>MaxBytes)throw new ValidationException("file","Keep resume uploads under 2 MB.");buffer.Write(chunk,0,n);}
        var bytes=buffer.ToArray();if(bytes.Length<8)throw new ValidationException("file","This file is empty or incomplete.");
        string text;
        try
        {
            if(ext==".pdf")
            {
                if(!bytes.AsSpan(0,5).SequenceEqual("%PDF-"u8))throw new InvalidDataException();
                using var pdf=UglyToad.PdfPig.PdfDocument.Open(bytes,new UglyToad.PdfPig.ParsingOptions{UseLenientParsing=false});
                if(pdf.NumberOfPages>10)throw new ValidationException("file","Upload a resume of at most ten pages.");
                var lines=new StringBuilder();foreach(var page in pdf.GetPages()){ct.ThrowIfCancellationRequested();lines.AppendLine(page.Text);if(lines.Length>40000)throw new ValidationException("file","Keep extracted resume text under 40,000 characters.");}text=lines.ToString();
            }
            else
            {
                using var zip=new ZipArchive(new MemoryStream(bytes),ZipArchiveMode.Read);
                if(zip.Entries.Count>1000 || zip.Entries.Sum(e=>e.Length)>8*1024*1024 || zip.Entries.Any(e=>e.Length>2*1024*1024 || e.Length>Math.Max(1,e.CompressedLength)*200))throw new ValidationException("file","The document has excessive compressed content.");
                if(zip.Entries.Any(e=>e.FullName.Contains("vbaProject",StringComparison.OrdinalIgnoreCase)||e.FullName.StartsWith("word/embeddings/",StringComparison.OrdinalIgnoreCase)))throw new ValidationException("file","Remove macros and embedded files before importing.");
                var entry=zip.GetEntry("word/document.xml")??throw new InvalidDataException();
                using var reader=XmlReader.Create(entry.Open(),new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=2*1024*1024});
                // Read the bounded XML once. ReadElementContentAsString inside a Read loop can skip adjacent runs.
                var document=System.Xml.Linq.XDocument.Load(reader);
                System.Xml.Linq.XNamespace word="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
                var lines=new StringBuilder();
                foreach(var paragraph in document.Descendants(word+"p"))
                {
                    ct.ThrowIfCancellationRequested();
                    foreach(var item in paragraph.Descendants())
                    {
                        if(item.Name==word+"t")lines.Append(item.Value);
                        else if(item.Name==word+"tab")lines.Append('\t');
                        else if(item.Name==word+"br")lines.AppendLine();
                    }
                    lines.AppendLine();
                    if(lines.Length>40000)throw new ValidationException("file","Keep extracted resume text under 40,000 characters.");
                }
                text=lines.ToString();
            }
        }
        catch(ValidationException){throw;}
        catch(Exception ex)when(ex is not OperationCanceledException){throw new ValidationException("file","This document could not be read. Remove encryption or upload a fresh PDF/DOCX; scanned PDFs need a text-based copy.");}
        text=text.Trim();if(requireText&&text.Length==0)throw new ValidationException("file","No readable text was found. For a scanned resume, use a text-based PDF or DOCX.");
        return(bytes,text,ext==".pdf"?"application/pdf":"application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    }
    private static readonly object FontLock=new();
    private static void Fonts(){lock(FontLock){if(GlobalFontSettings.FontResolver is null)GlobalFontSettings.FontResolver=new ResumeFontResolver();}}
    public static byte[] Pdf(ResumeContent c,ResumeTemplate t,bool watermark)
    {
        Fonts();using var doc=new PdfSharp.Pdf.PdfDocument();doc.Info.Title="Resume";doc.Info.Creator="Project Tracker";
        // Fail before producing (or charging for) a PDF with silently missing glyphs.
        doc.RenderEvents.RenderTextEvent+=(_,args)=>{
            if(args.CodePointGlyphIndexPairs.Any(pair=>pair.GlyphIndex==0
                && !Rune.IsWhiteSpace(new Rune(pair.CodePoint))))
                throw new ValidationException("content","Some characters are not supported by the PDF font. Download Word to preserve this text.");
        };
        XGraphics? g=null;double y=0;double width=595-t.Margin*2;int pages=0;
        var normal=new XFont("PT Noto",11,XFontStyleEx.Regular);var bold=new XFont("PT Noto",t.HeadingSize,XFontStyleEx.Bold);var title=new XFont("PT Noto",28,XFontStyleEx.Bold);var accent=new XSolidBrush(XColor.FromArgb(Convert.ToInt32(t.Accent[..2],16),Convert.ToInt32(t.Accent.Substring(2,2),16),Convert.ToInt32(t.Accent.Substring(4,2),16)));
        void Page(){g?.Dispose();if(++pages>30)throw new ValidationException("content","This resume is too long to export.");var p=doc.AddPage();p.Width=XUnit.FromPoint(595);p.Height=XUnit.FromPoint(842);g=XGraphics.FromPdfPage(p);y=t.Margin;
            if(watermark){var mark=new XFont("PT Noto",62,XFontStyleEx.Bold);g.DrawString("Project Tracker",mark,new XSolidBrush(XColor.FromArgb(242,237,255)),new XRect(0,370,595,100),XStringFormats.Center);}
            g.DrawString($"{pages}",new XFont("PT Noto",8),XBrushes.Gray,new XRect(t.Margin,810,width,12),XStringFormats.TopRight);
        }
        void Line(string text,XFont font,XBrush brush,bool centered=false){if(y+font.Size*1.5>790)Page();g!.DrawString(text,font,brush,new XRect(t.Margin,y,width,font.Size*1.5),centered?XStringFormats.TopCenter:XStringFormats.TopLeft);y+=font.Size*1.5;}
        void Text(string text,XFont? font=null,XBrush? brush=null,bool centered=false)
        {
            font??=normal;brush??=XBrushes.Black;
            foreach(var paragraph in text.Replace("\r","").Split('\n'))
            {
                var line="";
                foreach(var word in paragraph.Split(' ',StringSplitOptions.RemoveEmptyEntries))
                {
                    var candidate=line.Length==0?word:line+" "+word;
                    if(g!.MeasureString(candidate,font).Width>width&&line.Length>0)
                    {Line(line,font,brush,centered);line=word;}
                    else line=candidate;
                    while(g.MeasureString(line,font).Width>width)
                    {
                        var take=1;
                        while(take<line.Length&&g.MeasureString(line[..(take+1)],font).Width<=width)take++;
                        Line(line[..take],font,brush,centered);line=line[take..];
                    }
                }
                Line(line,font,brush,centered);
            }
        }
        Page();
        if(t.Rule){g!.DrawLine(new XPen(((XSolidBrush)accent).Color,2),t.Margin,y,595-t.Margin,y);y+=12;}
        Text(c.Name,title,accent,t.Centered);
        if(c.Headline.Length>0)Text(c.Headline,new XFont("PT Noto",12,XFontStyleEx.Bold),new XSolidBrush(XColor.FromArgb(78,94,119)),t.Centered);
        if(c.Contact.Length>0)Text(c.Contact,normal,new XSolidBrush(XColor.FromArgb(78,94,119)),t.Centered);
        y+=12;
        void Section(string name,string body)
        {
            if(string.IsNullOrWhiteSpace(body))return;
            if(y+60>790)Page();
            Text(name,bold,accent);
            if(t.Rule){g!.DrawLine(new XPen(((XSolidBrush)accent).Color,.6),t.Margin,y,595-t.Margin,y);y+=5;}
            Text(body);y+=12;
        }
        Section("Profile",c.Summary);foreach(var s in c.Sections)Section(s.Heading,s.Text);
        g!.Dispose();using var ms=new MemoryStream();doc.Save(ms,false);return ms.ToArray();
    }
    public static byte[] Docx(ResumeContent c,ResumeTemplate t,bool watermark)
    {
        using var ms=new MemoryStream();using(var doc=WordprocessingDocument.Create(ms,WordprocessingDocumentType.Document,true))
        {
            var main=doc.AddMainDocumentPart();var body=new W.Body();main.Document=new W.Document(body);
            void Para(string text,int size=22,bool bold=false,bool centered=false,string? color=null,bool heading=false,bool identity=false)
            {
                var p=new W.Paragraph();var pp=new W.ParagraphProperties();
                if(heading)pp.Append(new W.KeepNext());
                pp.Append(new W.WidowControl());
                if(identity&&t.Rule)pp.Append(new W.ParagraphBorders(new W.TopBorder{Val=W.BorderValues.Single,Color=t.Accent,Size=12,Space=10}));
                if(heading&&t.Rule)pp.Append(new W.ParagraphBorders(new W.BottomBorder{Val=W.BorderValues.Single,Color=t.Accent,Size=4,Space=4}));
                pp.Append(new W.SpacingBetweenLines{Before=heading?"180":"0",After="100"});
                if(centered)pp.Append(new W.Justification{Val=W.JustificationValues.Center});
                p.Append(pp);var rp=new W.RunProperties(new W.RunFonts{Ascii="Aptos",HighAnsi="Aptos"});
                if(bold)rp.Append(new W.Bold());if(color!=null)rp.Append(new W.Color{Val=color});rp.Append(new W.FontSize{Val=size.ToString()});
                var run=new W.Run(rp);var lines=text.Replace("\r","").Split('\n');
                for(var i=0;i<lines.Length;i++){if(i>0)run.Append(new W.Break());run.Append(new W.Text(lines[i]){Space=SpaceProcessingModeValues.Preserve});}
                p.Append(run);body.Append(p);
            }
            Para(c.Name,56,true,t.Centered,t.Accent,identity:true);Para(c.Headline,24,true,t.Centered,"4E5E77");Para(c.Contact,22,false,t.Centered,"4E5E77");
            if(c.Summary.Length>0){Para("Profile",t.HeadingSize*2,true,false,t.Accent,true);Para(c.Summary);}
            foreach(var s in c.Sections){Para(s.Heading,t.HeadingSize*2,true,false,t.Accent,true);Para(s.Text);}
            var props=new W.SectionProperties(new W.PageSize{Width=11906,Height=16838},new W.PageMargin{Top=(int)(t.Margin*20),Bottom=(int)(t.Margin*20),Left=(uint)(t.Margin*20),Right=(uint)(t.Margin*20),Header=400,Footer=400});
            if(watermark)
            {
                var header=main.AddNewPart<HeaderPart>();header.Header=new W.Header();
                // Standard Word VML text watermark, positioned behind the page text, editable by Word like other document watermarks.
                // The shape references a self-contained WordArt definition; an unresolved type can disappear in Word/PDF conversion.
                var mark=new W.Paragraph();mark.InnerXml="""
                    <w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
                      <w:pict>
                        <v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e">
                          <v:formulas>
                            <v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/>
                            <v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/>
                            <v:f eqn="if @0 @4 21600"/><v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/>
                            <v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/>
                          </v:formulas>
                          <v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>
                          <v:textpath on="t" fitshape="t"/>
                          <v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles>
                          <o:lock v:ext="edit" text="t" shapetype="t"/>
                        </v:shapetype>
                        <v:shape id="ProjectTrackerWatermark" type="#_x0000_t136" style="position:absolute;width:450pt;height:65pt;z-index:-251654144;mso-position-horizontal:center;mso-position-horizontal-relative:page;mso-position-vertical:center;mso-position-vertical-relative:page" fillcolor="#F2EDFF" stroked="f">
                          <v:path textpathok="t"/><v:textpath on="t" fitshape="t" style="font-family:Calibri;font-size:1pt" string="Project Tracker"/>
                        </v:shape>
                      </w:pict>
                    </w:r>
                    """;
                header.Header.Append(mark);header.Header.Save();props.PrependChild(new W.HeaderReference{Type=W.HeaderFooterValues.Default,Id=main.GetIdOfPart(header)});
            }
            body.Append(props);main.Document.Save();
        }return ms.ToArray();
    }
    private sealed class ResumeFontResolver:IFontResolver
    {
        public FontResolverInfo? ResolveTypeface(string familyName,bool isBold,bool isItalic)=>new(isBold?"NotoSans-Bold":"NotoSans-Regular");
        public byte[] GetFont(string faceName){using var stream=typeof(ResumeFiles).Assembly.GetManifestResourceStream($"ProjectManagement.Application.Features.Resumes.Fonts.{faceName}.ttf")??throw new InvalidOperationException("Resume font resource is missing.");using var ms=new MemoryStream();stream.CopyTo(ms);return ms.ToArray();}
    }
}
