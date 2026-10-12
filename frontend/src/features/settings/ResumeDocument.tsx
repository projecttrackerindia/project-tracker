import type { CSSProperties } from 'react';

export type ResumeDesign = { id:number; name:string; description:string; accent:string; centered:boolean; margin?:number; rule?:boolean; headingSize?:number; twoColumn?:boolean; headerColor?:string; headerText?:string; headingColor?:string; role?:string; bannerAccent?:string };
type Section={heading:string;text:string};
type Content={name:string;headline:string;contact:string;summary:string;sections:Section[]};
const sidebar = (s:Section) => /^(skills|core skills|technical skills|education|certification|certifications|languages)$/i.test(s.heading.trim());

export function ResumeDocument({content,design}:{content:Content;design?:ResumeDesign}) {
  const variables={ '--resume-accent':`#${design?.accent??'00E5FF'}`, '--resume-banner':`#${design?.headerColor??'0B1020'}`,
    '--resume-banner-text':`#${design?.headerText??'FFFFFF'}`, '--resume-heading':`#${design?.headingColor??'007786'}`,
    '--resume-banner-accent':`#${design?.bannerAccent??design?.accent??'00E5FF'}` } as CSSProperties;
  const section=(s:Section,i:number)=><section key={`${s.heading}:${i}`}><h2>{s.heading}</h2><p>{s.text}</p></section>;
  return <article className={`resume-paper ${design?.twoColumn?'supplied':''} ${design?.centered?'centered':''} ${!design?.twoColumn&&design?.rule?'ruled':''}`} style={variables} aria-label={`${design?.name??'Resume'} document preview`}>
    <span className="resume-watermark" aria-hidden="true">Project Tracker</span>
    <header><h1>{content.name||'Your name'}</h1><p>{content.headline||'Your professional headline'}</p><small>{content.contact||'Add your contact details'}</small></header>
    {design?.twoColumn?<div className="resume-paper-columns"><div className="resume-paper-sidebar">{content.summary&&section({heading:'Profile',text:content.summary},-1)}{content.sections.filter(sidebar).map(section)}</div><div className="resume-paper-main">{content.sections.filter(s=>!sidebar(s)).map(section)}</div></div>:<>{content.summary&&section({heading:'Profile',text:content.summary},-1)}{content.sections.map(section)}</>}
  </article>;
}

export function TemplateThumbnail({design}:{design:ResumeDesign}) {
  return <span className="resume-design-thumbnail" aria-hidden="true" style={{'--thumbnail-banner':`#${design.headerColor??'17243C'}`,'--thumbnail-accent':`#${design.accent}`} as CSSProperties}>
    <span className="resume-thumbnail-banner"><i/><i/></span><span className="resume-thumbnail-columns"><span><i/><i/><i/><i/></span><span><i/><i/><i/><i/><i/><i/></span></span>
  </span>;
}
