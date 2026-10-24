import type { CSSProperties } from 'react';

export type ResumeDesign = { id:number; name:string; description:string; accent:string; centered:boolean; margin?:number; rule?:boolean; headingSize?:number; twoColumn?:boolean; headerColor?:string; headerText?:string; headingColor?:string; role?:string; bannerAccent?:string };
type Section={heading:string;text:string};
type Content={name:string;headline:string;contact:string;summary:string;sections:Section[]};
const sidebar = (s:Section) => /^(skills|core skills|technical skills|education|certification|certifications|languages)$/i.test(s.heading.trim());
const hex = (v:string|undefined, fallback:string) => `#${v ?? fallback}`;

/** The on-screen page follows the export: an A4 page 595pt wide, so margins and heading sizes are drawn in the same proportions. */
export function ResumeDocument({content,design}:{content:Content;design?:ResumeDesign}) {
  const variables={ '--resume-accent':hex(design?.accent,'1F2937'), '--resume-banner':hex(design?.headerColor,'0F172A'),
    '--resume-banner-text':hex(design?.headerText,'FFFFFF'), '--resume-heading':hex(design?.headingColor ?? design?.accent,'1F2937'),
    '--resume-banner-accent':hex(design?.bannerAccent ?? design?.accent,'7DD3FC'),
    '--resume-margin':String(design?.margin ?? 50), '--resume-heading-size':String(design?.headingSize ?? 12) } as CSSProperties;
  const kind=[design?.twoColumn?'supplied':'', design?.centered?'centered':'', design?.rule?'ruled':''].filter(Boolean).join(' ');
  // Like the export, a section with no text is left out of the page.
  const sections=content.sections.filter(s=>s.text.trim());
  const section=(s:Section,i:number)=><section key={`${s.heading}:${i}`}><h2>{s.heading}</h2><p>{s.text}</p></section>;
  return <article className={`resume-paper ${kind}`} style={variables} aria-label={`${design?.name??'Resume'} document preview`}>
    <span className="resume-watermark" aria-hidden="true">Project Tracker</span>
    <header><h1>{content.name||'Your name'}</h1><p>{content.headline||'Your professional headline'}</p><small>{content.contact||'Your contact details'}</small></header>
    {design?.twoColumn
      ?<div className="resume-paper-columns"><div className="resume-paper-sidebar">{content.summary.trim()&&section({heading:'Profile',text:content.summary},-1)}{sections.filter(sidebar).map(section)}</div><div className="resume-paper-main">{sections.filter(s=>!sidebar(s)).map(section)}</div></div>
      :<>{content.summary.trim()&&section({heading:'Profile',text:content.summary},-1)}{sections.map(section)}</>}
  </article>;
}

/** A small drawing of the page: banner and sidebar, or one column; centred or left; with or without rules; tight or roomy. */
export function TemplateThumbnail({design}:{design:ResumeDesign}) {
  const style={'--thumb-accent':hex(design.twoColumn?design.headingColor??design.accent:design.accent,'1F2937'),'--thumb-banner':hex(design.headerColor,'0F172A'),
    '--thumb-banner-accent':hex(design.bannerAccent??design.accent,'7DD3FC'),'--thumb-pad':`${Math.round((design.margin??50)/10)}px`} as CSSProperties;
  const kind=['resume-thumb',design.twoColumn?'two':'one',design.centered?'centered':'',design.rule?'ruled':''].filter(Boolean).join(' ');
  return <span className={kind} aria-hidden="true" style={style}>
    {design.twoColumn
      ?<><span className="resume-thumb-banner"><i/><i/></span><span className="resume-thumb-columns"><span><i/><i/><i/><i/></span><span><i/><i/><i/><i/><i/><i/></span></span></>
      :<><span className="resume-thumb-name"><i/><i/></span><span className="resume-thumb-body"><i/><i/><i/><i/><i/><i/><i/></span></>}
  </span>;
}
