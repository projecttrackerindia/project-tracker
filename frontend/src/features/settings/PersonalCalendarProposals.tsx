import { useState } from 'react';
import './PersonalCalendarProposals.css';
import { ApiError } from '../../api/client';
import { personalCalendarApi } from '../../api/endpoints.platform';
import type { PersonalCalendarProposal } from '../../api/types';
import { Field } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const blank={title:'',description:'',start:'',end:''};
const statusLabel={draft:'Ready for review',sending:'Creating',unknown:'Needs verification',verified:'Verified'};
const errorText=(e:unknown)=>e instanceof ApiError?e.errors[0]?.message??e.message:'The calendar request could not be completed. Reload the receipt before taking further action.';
const time=(p:PersonalCalendarProposal,value:string)=>new Date(value).toLocaleString(undefined,{timeZone:p.timeZone,dateStyle:'medium',timeStyle:'short'})+' ('+p.timeZone+')';
export function PersonalCalendarProposals(){
  const wid=useWorkspaceId();
  const list=useWsQuery(['account','calendar-proposals'],personalCalendarApi.list);
  const options=useWsQuery(['account','calendar-options'],personalCalendarApi.options);
  const [fields,setFields]=useState(blank);
  const [selected,setSelected]=useState<PersonalCalendarProposal|null>(null);
  const [busy,setBusy]=useState(false);
  const [availability,setAvailability]=useState<string|null>(null);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const refresh=()=>invalidateWorkspace(wid,'account','calendar-proposals');
  const ready=!!(options.data?.enabled&&options.data.calendarAccess&&options.data.account);
  const choose=async(id?:string)=>{
    if(!selected&&Object.values(fields).some(Boolean)&&!(await confirmDialog({title:'Discard unsaved proposal?',message:'These unsaved calendar details will be discarded.',confirmText:'Discard'})))return;
    setBusy(true);
    try{setSelected(id?await personalCalendarApi.get(id):null);setFields(blank);setAvailability(null);}catch(e){toast(errorText(e),'error');}finally{setBusy(false);}
  };
  const save=async()=>{
    setBusy(true);
    try{
      const start=new Date(fields.start),end=new Date(fields.end);
      if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())){toast('Choose valid start and end times.','error');return;}
      setSelected(await personalCalendarApi.save({...fields,start:start.toISOString(),end:end.toISOString(),timeZone:zone}));
      setFields(blank);setAvailability(null);await refresh();toast('Private proposal saved. No calendar event has been created.');
    }catch(e){toast(errorText(e),'error');}finally{setBusy(false);}
  };
  const check=async()=>{
    if(!selected)return;setBusy(true);
    try{const result=await personalCalendarApi.availability(selected.id,selected.version);setAvailability(result.blockingEvents?result.blockingEvents+' blocking event(s). Choose another time.':'No blocking event was found. Availability will be checked again when you confirm.');}catch(e){setAvailability(null);toast(errorText(e),'error');}finally{setBusy(false);}
  };
  const confirm=async()=>{
    if(!selected||!ready||!options.data?.account)return;
    const p=selected,account=options.data.account;setBusy(true);
    try{
      if(!(await confirmDialog({title:'Create this personal calendar block?',message:'Account: '+account+'\nTitle: '+p.title+'\nFrom: '+time(p,p.startUtc)+'\nTo: '+time(p,p.endUtc)+'\nExact start: '+p.startUtc+'\nExact end: '+p.endUtc+'\n\n'+p.description+'\n\nYou are approving saved version '+p.version+'. This creates a block in your primary Google calendar with no attendees. Only that calendar is checked for conflicts.',confirmText:'Confirm calendar block'})))return;
      const result=await personalCalendarApi.confirm(p.id,{version:p.version,confirmed:true,account});setSelected(result);setAvailability(null);await refresh();
      toast(result.status==='verified'?'Google Calendar event verified.':'Calendar outcome uncertain. Check provider status; this proposal will not be sent again.',result.status==='verified'?'success':'warning');
    }catch(e){toast(errorText(e),'error');try{setSelected(await personalCalendarApi.get(p.id));}catch{/* Reload remains available. */}}finally{setBusy(false);}
  };
  const reconcile=async()=>{
    if(!selected)return;setBusy(true);
    try{const result=await personalCalendarApi.reconcile(selected.id);setSelected(result);await refresh();toast(result.status==='verified'?'Calendar event verified.':'The exact event could not be verified. No new event was created.',result.status==='verified'?'success':'warning');}catch(e){toast(errorText(e),'error');}finally{setBusy(false);}
  };
  const remove=async()=>{
    if(!selected||!(await confirmDialog({title:'Remove this local proposal?',message:'This erases its local notes. A verified block remains in Google Calendar; manage it there.',confirmText:'Remove',danger:true})))return;
    setBusy(true);try{await personalCalendarApi.remove(selected.id);setSelected(null);setFields(blank);await refresh();}catch(e){toast(errorText(e),'error');}finally{setBusy(false);}
  };
  return <section className="card" style={{padding:22,marginTop:18,minWidth:0}}>
    <h3>Private calendar proposals</h3>
    <p className="muted">Save and review a personal time block before adding it to your calendar. Other members cannot read your proposals. Manual editing uses no AI credits.</p>
    <p className="muted">{options.data?.enabled?'Connected calendar: '+(options.data.account||'Connect Google Calendar in My account › Connected accounts.'):'Calendar creation is awaiting administrator setup. You can save private proposals.'}</p>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>
      <button className="btn" disabled={busy} onClick={()=>void choose()}>New calendar proposal</button>
      <button className="btn btn-ghost" disabled={busy} onClick={()=>void refresh()}>Reload calendar proposals</button>
    </div>
    {list.isError&&<p role="alert">Calendar proposals could not be loaded.</p>}
    <div className="personal-calendar-grid">
      <div style={{display:'grid',gap:8,alignContent:'start',minWidth:0}}>
        {!list.isLoading&&!list.data?.length&&<p className="muted">No saved calendar proposals.</p>}
        {list.data?.map(p=><button key={p.id} className={'btn '+(selected?.id===p.id?'btn-primary':'')} style={{height:'auto',whiteSpace:'normal',textAlign:'left',justifyContent:'flex-start',overflowWrap:'anywhere',padding:12}} disabled={busy} onClick={()=>void choose(p.id)}>{p.title} · {statusLabel[p.status]}</button>)}
      </div>
      <div style={{minWidth:0}}>
        {!selected?<>
          <Field label="Calendar title"><input aria-label="Calendar title" className="input" maxLength={200} value={fields.title} disabled={busy} onChange={e=>setFields({...fields,title:e.target.value})}/></Field>
          <Field label="Calendar notes"><textarea aria-label="Calendar notes" className="input" rows={5} maxLength={6000} value={fields.description} disabled={busy} onChange={e=>setFields({...fields,description:e.target.value})}/></Field>
          <p className="muted">Enter times in your browser time zone: {zone}. Exact times are shown before confirmation.</p>
          <Field label="Block start"><input aria-label="Block start" className="input" type="datetime-local" value={fields.start} disabled={busy} onChange={e=>setFields({...fields,start:e.target.value})}/></Field>
          <Field label="Block end"><input aria-label="Block end" className="input" type="datetime-local" value={fields.end} disabled={busy} onChange={e=>setFields({...fields,end:e.target.value})}/></Field>
          <button className="btn" disabled={busy||!fields.title.trim()||!fields.start||!fields.end} onClick={()=>void save()}>Save calendar proposal</button>
        </>:<>
          <h4 style={{overflowWrap:'anywhere'}}>{selected.title}</h4>
          <p>{time(selected,selected.startUtc)} — {time(selected,selected.endUtc)}</p>
          <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{selected.description}</p>
          {selected.status==='verified'&&<p role="status">Verified in Google Calendar. Account: {selected.confirmedAccount}</p>}
          {['unknown','sending'].includes(selected.status)&&<p role="alert">Calendar outcome uncertain. Check provider status to verify the saved event. A missing or changed event will not trigger another calendar write.</p>}
          {availability&&<p role="status">{availability}</p>}
          {selected.status==='draft'&&<p className="muted">Conflict checks cover only the connected account's primary Google calendar. Other calendars and attendee availability are not checked.</p>}
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            {selected.status==='draft'&&<><button className="btn" disabled={busy||!ready} onClick={()=>void check()}>Check calendar availability</button><button className="btn btn-primary" disabled={busy||!ready} onClick={()=>void confirm()}>Review calendar block</button></>}
            {['unknown','sending'].includes(selected.status)&&<button className="btn" disabled={busy||!ready} onClick={()=>void reconcile()}>Check provider status</button>}
            {['draft','verified'].includes(selected.status)&&<button className="btn btn-ghost" disabled={busy} onClick={()=>void remove()}>Remove calendar proposal</button>}
          </div>
        </>}
      </div>
    </div>
  </section>;
}
