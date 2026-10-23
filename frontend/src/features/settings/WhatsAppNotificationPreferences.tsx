import { useEffect, useRef, useState } from 'react';
import { get, put } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { Field } from '../../components/ui';
import { WhatsAppDeliveryHistory } from './WhatsAppDeliveryHistory';
import { toast } from '../../stores/ui';
import { formatDateTime } from '../../lib/format';
import { appZone } from '../../lib/zone';
export interface WhatsAppPreferences {
  version:number; optedIn:boolean; canEnable:boolean; taskAssignments:boolean; overdue:boolean; supportUpdates:boolean; reminders:boolean; approvals:boolean;
  timeZone:string; quietStartMinutes:number; quietEndMinutes:number; requiredConsentVersion:string;
  consentAt:string|null; expiresAt:string|null; deliveryEnabled:boolean;
}
export const whatsAppPrefsUrl='/me/whatsapp-contact/notification-preferences';
const url=whatsAppPrefsUrl;
/** The kinds of notification WhatsApp can carry (fixed, approved message templates); everything else stays in the app, email and push. */
export const WHATSAPP_KINDS=[['taskAssignments','Task assignments'],['overdue','Overdue task reminders'],['supportUpdates','Support ticket updates'],
  ['reminders','Your own reminders when they go off'],['approvals','Approvals waiting for you (documents, timesheets)']] as const;
const time=(minutes:number)=>`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
const minutes=(value:string)=>{const [h,m]=value.split(':').map(Number);return h*60+m;};
export function WhatsAppNotificationPreferences() {
  const wid=useWorkspaceId(); const userId=useAuth(s=>s.ctx?.user.id); const scope=String(wid)+':'+String(userId);
  const current=useRef(scope);
  const query=useWsQuery(['account','whatsapp-contact','notification-preferences',userId],()=>get<WhatsAppPreferences>(url));
  const [draft,setDraft]=useState<WhatsAppPreferences|null>(null); const [accepted,setAccepted]=useState(false); const [busy,setBusy]=useState(false);
  useEffect(()=>{current.current=scope;setDraft(null);setAccepted(false);setBusy(false);},[scope]);
  useEffect(()=>{if(query.data){setDraft(query.data);setAccepted(false);}},[query.data,scope]);
  const save=async(optIn:boolean)=>{
    if(!draft||busy||(optIn&&!accepted))return;
    setBusy(true);
    try {
      const saved=await put<WhatsAppPreferences>(url,{version:draft.version,optIn,acceptedConsentVersion:optIn&&accepted?draft.requiredConsentVersion:null,
        taskAssignments:draft.taskAssignments,overdue:draft.overdue,supportUpdates:draft.supportUpdates,reminders:draft.reminders,approvals:draft.approvals,
        timeZone:appZone(),quietStartMinutes:draft.quietStartMinutes,quietEndMinutes:draft.quietEndMinutes});
      if(current.current===scope){setAccepted(false);await query.refetch();if(current.current===scope)toast(optIn?(saved.deliveryEnabled?'Notification preferences saved.':'Notification preferences saved. Delivery is awaiting activation.'):'WhatsApp notification consent removed.','success');}
    } catch(e) {
      if(current.current===scope){toast(e instanceof Error?e.message:'Could not save notification preferences.','error');await query.refetch();}
    } finally {if(current.current===scope)setBusy(false);}
  };
  return <section aria-labelledby="whatsapp-notifications-title" style={{marginTop:24}}>
    <h4 id="whatsapp-notifications-title">WhatsApp notification preferences</h4>
    <p>Select the messages you want for this organization.{!draft?.deliveryEnabled&&" Delivery is awaiting platform activation."}</p>
    {query.isLoading&&<p role="status">Loading preferences...</p>}
    {query.error&&<p role="alert">{query.error.message}</p>}
    {draft&&<form onSubmit={e=>{e.preventDefault();void save(true);}}>
      {draft.optedIn&&<p role="status">Consent recorded until {draft.expiresAt?formatDateTime(draft.expiresAt):''}.{draft.deliveryEnabled?' Notifications follow your quiet hours and delivery allowance.':' Messages are not being sent.'}</p>}
      {!draft.canEnable&&<p>Verify your number on an eligible, active organization connection before enabling preferences.</p>}
      <fieldset disabled={busy||!draft.canEnable} style={{border:0,padding:0,margin:0,minWidth:0}}>
        <legend>Message categories</legend>
        {WHATSAPP_KINDS.map(([key,label])=>
          <label key={key} style={{display:'flex',gap:8,margin:'8px 0'}}><input type="checkbox" checked={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.checked})}/>{label}</label>)}
        <p className="muted">Quiet hours use your time zone ({appZone()}), set in Notification Center → Schedule.</p>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:12}}>
          <Field label="Quiet hours start"><input className="input" type="time" required aria-label="Quiet hours start" value={time(draft.quietStartMinutes)} onChange={e=>{if(e.target.value)setDraft({...draft,quietStartMinutes:minutes(e.target.value)});}}/></Field>
          <Field label="Quiet hours end"><input className="input" type="time" required aria-label="Quiet hours end" value={time(draft.quietEndMinutes)} onChange={e=>{if(e.target.value)setDraft({...draft,quietEndMinutes:minutes(e.target.value)});}}/></Field>
        </div>
        <p className="muted">Quiet hours can cross midnight and use the time zone above.</p>
        <label style={{display:'flex',gap:8,alignItems:'flex-start'}}><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/><span>I agree to receive the selected organization notifications at my verified WhatsApp number when delivery is activated. I can revoke consent here. This does not authorize marketing, voice calls, or access to additional projects.</span></label>
        <button className="btn btn-primary" type="submit" disabled={!accepted||!(draft.taskAssignments||draft.overdue||draft.supportUpdates||draft.reminders||draft.approvals)}>{busy?'Saving...':'Save WhatsApp preferences'}</button>
      </fieldset>
      {draft.optedIn&&<button className="btn" type="button" disabled={busy} onClick={()=>void save(false)}>Revoke WhatsApp notifications</button>}
    </form>}
    {draft?.optedIn&&<WhatsAppDeliveryHistory />}
  </section>;
}
