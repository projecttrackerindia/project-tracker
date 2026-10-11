import { WhatsAppNotificationPreferences } from './WhatsAppNotificationPreferences';
import { useEffect, useRef, useState } from 'react';
import { get, post, del } from '../../api/client';
import { useWsQuery, invalidateWorkspace } from '../../lib/hooks';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { Field } from '../../components/ui';
import { confirmDialog, toast } from '../../stores/ui';
interface ContactStatus { enabled:boolean; eligible:boolean; businessName:string|null; status:string; maskedPhone:string|null; expiresAt:string|null; verifiedAt:string|null; outboundEnabled:boolean }
interface Challenge { message:string; expiresAt:string }
export function WhatsAppContactSection() {
  const wid=useWorkspaceId(); const userId=useAuth(s=>s.ctx?.user.id);
  const scope=String(wid)+':'+String(userId); const current=useRef(scope);
  const challengeKey=[wid,'account','whatsapp-contact-challenge',userId];
  const cachedChallenge=()=>{
    const value=queryClient.getQueryData<Challenge>(challengeKey);
    if(value&&Date.parse(value.expiresAt)>Date.now())return value;
    queryClient.removeQueries({queryKey:challengeKey,exact:true});return null;
  };
  const [phone,setPhone]=useState(''); const [accepted,setAccepted]=useState(false);
  const [challenge,setChallenge]=useState<Challenge|null>(cachedChallenge); const [busy,setBusy]=useState(false);
  const status=useWsQuery(['account','whatsapp-contact'],()=>get<ContactStatus>('/me/whatsapp-contact'));
  useEffect(()=>{current.current=scope;setPhone('');setAccepted(false);setChallenge(cachedChallenge());setBusy(false);},[scope]);
  const remember=(value:Challenge|null)=>{
    if(value)queryClient.setQueryData(challengeKey,value);
    else queryClient.removeQueries({queryKey:challengeKey,exact:true});
    setChallenge(value);
  };
  useEffect(()=>{if(status.data&&status.data.status!=='pending')remember(null);},[status.data?.status]);
  useEffect(()=>{if(!challenge)return;const timer=setTimeout(()=>remember(null),Math.max(0,Date.parse(challenge.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[challenge?.expiresAt,scope]);
  const refresh=()=>invalidateWorkspace(wid,'account','whatsapp-contact');
  const start=async()=>{
    if(!accepted||busy)return; setBusy(true);
    try{const result=await post<Challenge>('/me/whatsapp-contact',{phone,acknowledged:accepted});
      if(current.current===scope){setPhone('');await refresh();if(current.current===scope)remember(result);}}
    catch(e){if(current.current===scope)toast(e instanceof Error?e.message:'Could not prepare phone linking.','error');}
    finally{if(current.current===scope)setBusy(false);}
  };
  const unlink=async()=>{
    if(!await confirmDialog({title:'Remove your WhatsApp link?',message:'Erase your stored phone, revoke WhatsApp notification consent, and cancel any pending code for this organization.',confirmText:'Remove link',danger:true}))return;
    setBusy(true);try{await del('/me/whatsapp-contact');if(current.current===scope){remember(null);setAccepted(false);await refresh();}}
    catch(e){if(current.current===scope)toast(e instanceof Error?e.message:'Could not remove the link.','error');}
    finally{if(current.current===scope)setBusy(false);}
  };
  const s=status.data;
  if(s?.status==='unavailable')return null;
  return <section className="card" aria-labelledby="whatsapp-contact-title">
    <div className="card-head"><div><h3 id="whatsapp-contact-title">Your WhatsApp link</h3><p>A private phone link for the organization you are viewing.</p></div></div>
    <div className="card-body">
      {status.isLoading&&<p role="status">Checking phone-link status...</p>}
      {status.error&&<p role="alert">{status.error.message}</p>}
      {s&&<>
        <p>Linking proves that you control this number. It does not enable notifications or expand your project permissions.</p>
        {!s.eligible&&<p>This organization's active plan does not currently include WhatsApp integration.</p>}
        {!s.enabled&&<p>Phone linking is awaiting a configured business connection and platform activation.</p>}
        {s.status==='verified'&&<p role="status">Verified number: {s.maskedPhone}. Manage notification consent and quiet hours below.</p>}
        {s.status==='pending'&&<p role="status">Waiting for your message from {s.maskedPhone}. Code expires {s.expiresAt?new Date(s.expiresAt).toLocaleString():''}.</p>}
        {challenge&&s.status==='pending'&&<div><p>From the number you entered, send this exact message to {s.businessName||'your organization'}'s WhatsApp business number. Ask your administrator for that number.</p>
          <p><code style={{overflowWrap:'anywhere',wordBreak:'break-word'}}>{challenge.message}</code></p>
          <p className="muted">Keep the code private. After a page reload, prepare a new code.</p></div>}
        {s.status==='pending'&&<button className="btn" disabled={busy} onClick={()=>void status.refetch()}>Check verification</button>}
        {s.enabled&&s.eligible&&s.status!=='verified'&&<form onSubmit={e=>{e.preventDefault();void start();}}>
          <Field label="Your WhatsApp number" hint="Include + and the country code. No spaces."><input className="input" type="tel" autoComplete="tel" aria-label="Your WhatsApp number" maxLength={16} value={phone} disabled={busy} onChange={e=>setPhone(e.target.value)}/></Field>
          <label style={{display:'flex',gap:8,alignItems:'flex-start'}}><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)}/><span>I agree to link my own number to my account in this organization. Project Tracker will securely store it to verify this link. This is not consent to receive notifications.</span></label>
          <button className="btn btn-primary" disabled={busy||!accepted||!phone} type="submit">{busy?'Preparing code...':s.status==='pending'?'Prepare a new code':'Prepare verification code'}</button>
        </form>}
        {s.status==='verified'&&<WhatsAppNotificationPreferences/>}
        {s.status!=='unlinked'&&<button className="btn" disabled={busy} onClick={()=>void unlink()}>Remove my link</button>}
      </>}
    </div>
  </section>;
}
