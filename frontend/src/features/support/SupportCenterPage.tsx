import { useState, useRef, lazy, Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import { teamApi } from '../../api/endpoints';
import type { WorkTask, Priority } from '../../api/types';
import { Icon } from '../../components/Icon';
import { PageHead, PageLoader, ErrorState, Modal, PriorityBadge, PriorityOptions } from '../../components/ui';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { useCan, useWorkspaceId } from '../../stores/auth';
import { confirmDialog } from '../../stores/ui';
import { WorkTaskModal } from '../work/WorkTaskModal';
import { SupportResolution } from '../work/SupportResolution';
import { SlaChip } from '../work/Sla';
import './supportCenter.css';
const WorkflowStudio=lazy(()=>import('./SupportWorkflowStudio').then(m=>({default:m.SupportWorkflowStudio})));
const WorkflowRuns=lazy(()=>import('./SupportWorkflowStudio').then(m=>({default:m.TicketWorkflowRuns})));
type QueueItem={id:string;key:string;title:string;priority:Priority;state:string;category:string;assigneeId:string|null;teamId:string|null;responseDueAt:string|null;resolutionDueAt:string|null;version:number};
type Interaction={id:string;authorId:string;body:string;visibility:string;kind:string;createdAt:string};
type Ticket={id:string;work:WorkTask;state:string;category:string;region:string;language:string;teamId:string|null;version:number;staff:boolean;interactions:Interaction[];links:string[];handoffReason:string;customFields:Record<string,string>};
export function SupportCenterPage(){const workspace=useWorkspaceId();return <SupportWorkspacePage key={workspace}/>;}
function SupportWorkspacePage(){
  const canReports=useCan('reports.view');const canWorkflow=useCan('workflow.manage');const [tab,setTab]=useState<'tickets'|'workflows'>('tickets');
  const canCreate=useCan('work.create');const qc=useQueryClient();const [query,setQuery]=useState('');const term=useDebounced(query);const [state,setState]=useState('');const [page,setPage]=useState(1);const [selected,setSelected]=useState<string|null>(null);const [create,setCreate]=useState(false);
  const list=useWsQuery(['support','tickets',term,state,page],()=>api<QueueItem[]>('GET','/support/tickets'+qs({query:term,state,page})));
  const refresh=()=>qc.invalidateQueries({predicate:q=>q.queryKey.includes('support')||q.queryKey.includes('work')});
  return <div className="support-center"><PageHead title="Support center" sub="A clear queue, accountable ownership and verified resolution." >{canCreate&&tab==='tickets'?<button className="btn btn-primary" onClick={()=>setCreate(true)}><Icon name="plus"/>New ticket</button>:undefined}</PageHead><nav className="support-tabs" aria-label="Support views"><button className="btn" aria-pressed={tab==='tickets'} onClick={()=>setTab('tickets')}><Icon name="inbox"/>Tickets</button>{canWorkflow&&<button className="btn" aria-pressed={tab==='workflows'} onClick={()=>setTab('workflows')}><Icon name="workflow"/>Workflow studio</button>}</nav><div hidden={tab!=='tickets'}><div className="support-tools"><input aria-label="Search support tickets" value={query} placeholder="Search tickets or categories" maxLength={200} onChange={e=>{setQuery(e.target.value);setPage(1);}}/><select aria-label="Ticket state" value={state} onChange={e=>{setState(e.target.value);setPage(1);}}><option value="">All states</option>{['open','waiting','handoff','resolved','closed','merged','cancelled'].map(s=><option key={s}>{s}</option>)}</select></div>
    {canReports&&<SupportMetrics/>}<p className="support-note">Assignments, attachments, work history and SLA settings use the existing Operations tools. External messaging is disabled until provider accounts and verified customer identity are configured.</p>
    {list.isLoading?<PageLoader/>:list.error?<ErrorState error={list.error} retry={()=>void list.refetch()}/>:!list.data?.length?<div className="support-empty"><Icon name="inbox"/><h3>No tickets in this queue</h3><p>Create a ticket or adjust the filters.</p></div>:<div className="support-queue" role="list">{list.data.map(t=><button key={t.id} role="listitem" className="support-ticket-row" onClick={()=>setSelected(t.id)}><span className="support-ticket-key">{t.key}</span><div><b>{t.title}</b><small>{t.category}{t.resolutionDueAt?` · Resolution due ${new Date(t.resolutionDueAt).toLocaleString()}`:''}</small></div><PriorityBadge priority={t.priority}/><span className="badge badge-neutral">{t.state}</span></button>)}</div>}
    <div className="support-pagination"><button className="btn" disabled={page<=1} onClick={()=>setPage(page-1)}>Previous</button><span>Page {page}</span><button className="btn" disabled={(list.data?.length??0)<25} onClick={()=>setPage(page+1)}>Next</button></div>
    </div>{tab==='workflows'&&<Suspense fallback={<PageLoader/>}><WorkflowStudio/></Suspense>}
    {create&&<CreateTicket onClose={()=>setCreate(false)} onCreated={id=>{setCreate(false);setSelected(id);void refresh();}}/>}{selected&&<TicketDetail key={selected} id={selected} onClose={()=>{setSelected(null);void refresh();}} onSelect={setSelected}/>}</div>;
}
function CreateTicket({onClose,onCreated}:{onClose:()=>void;onCreated:(id:string)=>void}){
  const types=useWsQuery(['work','types'],()=>api<{id:string;name:string;isActive:boolean}[]>('GET','/work-types'));const [title,setTitle]=useState('');const [description,setDescription]=useState('');const [category,setCategory]=useState('General');const [type,setType]=useState('');const [priority,setPriority]=useState<Priority>('Medium');const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  return <Modal title="New support ticket" onClose={onClose}><form className="support-form" onSubmit={e=>{e.preventDefault();setBusy(true);setError(null);void api<Ticket>('POST','/support/tickets',{title,description,category,priority,workTypeId:type}).then(r=>onCreated(r.id)).catch(e=>setError(e instanceof Error?e.message:'Could not create ticket.')).finally(()=>setBusy(false));}}>{error&&<p role="alert" className="form-error">{error}</p>}<label>Title<input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Details<textarea maxLength={8000} rows={5} value={description} onChange={e=>setDescription(e.target.value)}/></label><label>Category<input required maxLength={120} value={category} onChange={e=>setCategory(e.target.value)}/></label><label>Work type<select required value={type} onChange={e=>setType(e.target.value)}><option value="">Choose a type</option>{types.data?.filter(t=>t.isActive).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>{types.error&&<p role="alert">{types.error.message}</p>}<label>Priority<select value={priority} onChange={e=>setPriority(e.target.value as Priority)}><PriorityOptions/></select></label><button className="btn btn-primary" disabled={busy||!type}>{busy?'Creating…':'Create ticket'}</button></form></Modal>;
}
function TicketDetail({id,onClose,onSelect}:{id:string;onClose:()=>void;onSelect:(id:string)=>void}){
  const q=useWsQuery(['support','ticket',id],()=>api<Ticket>('GET',`/support/tickets/${id}`));const qc=useQueryClient();const [body,setBody]=useState('');const [internal,setInternal]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [edit,setEdit]=useState(false);const [next,setNext]=useState('');const [reason,setReason]=useState('');const [linked,setLinked]=useState('');
  async function run(fn:()=>Promise<unknown>){setBusy(true);setError(null);try{await fn();await qc.invalidateQueries({predicate:x=>x.queryKey.includes('support')||x.queryKey.includes('work')});}catch(e){setError(e instanceof Error?e.message:'This action failed. Retry after checking the latest ticket.');}finally{setBusy(false);}}
  const attempt=useRef<{body:string;visibility:string;key:string}|null>(null);
  const t=q.data;
  return <Modal title={t?`${t.work.key} · ${t.work.title}`:'Support ticket'} onClose={onClose} size="xl">{q.isLoading?<PageLoader/>:!t?<ErrorState error={q.error} retry={()=>void q.refetch()}/>:<div className="support-detail">{error&&<p role="alert" className="form-error">{error}</p>}<div className="support-detail-meta"><PriorityBadge priority={t.work.priority}/><span className="badge badge-neutral">{t.state}</span><span>{t.category}</span>{t.work.sla&&<SlaChip sla={t.work.sla}/>}<button className="btn btn-sm" onClick={()=>setEdit(true)}>Work, assignment & files</button></div><p>{t.work.description}</p>{t.handoffReason&&<p className="support-note">Human handoff: {t.handoffReason}</p>}
    {t.staff&&<TicketMetadata key={t.version} ticket={t} onSaved={()=>void q.refetch()}/>}
    <TicketThread key={t.version} ticket={t} onReload={()=>void q.refetch()}/>
    {t.state!=='closed'&&t.state!=='merged'&&t.state!=='cancelled'&&<form className="support-form" onSubmit={e=>{e.preventDefault();void run(async()=>{const visibility=t.staff&&internal?'internal':'public';
      if(!attempt.current||attempt.current.body!==body||attempt.current.visibility!==visibility)attempt.current={body,visibility,key:crypto.randomUUID()};
      await api('POST',`/support/tickets/${id}/messages`,{body,visibility,requestKey:attempt.current.key});attempt.current=null;setBody('');});}}><label>{t.staff&&internal?'Internal note':'Reply to requester'}<textarea required maxLength={8000} rows={4} value={body} onChange={e=>setBody(e.target.value)}/></label>{t.staff&&<label className="support-checkbox"><input type="checkbox" checked={internal} onChange={e=>setInternal(e.target.checked)}/>Private staff note</label>}<button className="btn btn-primary" disabled={busy}>{busy?'Saving…':'Save reply'}</button><small>Replies are saved in Project Tracker. No external message is sent.</small></form>}
    {t.staff&&<details className="support-actions"><summary>State, handoff and related tickets</summary><form className="support-form" onSubmit={e=>{e.preventDefault();void run(async()=>{if(['merged','closed','cancelled'].includes(next)&&!await confirmDialog({title:next==='merged'?'Merge ticket?':next==='cancelled'?'Cancel ticket?':'Close ticket?',message:next==='merged'?'The source work will be cancelled and linked to the target. Its original history is retained.':next==='cancelled'?'This cancels the underlying work and stops replies until the ticket is reopened.':'Closure requires completed work and requester acceptance.',confirmText:'Confirm'}))return;await api('POST',`/support/tickets/${id}/state`,{version:t.version,state:next,reason,relatedTicketId:linked||null});setNext('');});}}><label>Action<select required value={next} onChange={e=>setNext(e.target.value)}><option value="">Choose action</option>{['open','waiting','resolved','closed','handoff','linked','merged','cancelled'].map(s=><option key={s}>{s}</option>)}</select></label><label>Reason<textarea maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>{['linked','merged'].includes(next)&&<label>Related ticket ID<input required value={linked} onChange={e=>setLinked(e.target.value)}/></label>}<button className="btn" disabled={busy||!next}>Apply action</button></form></details>}
    {!!t.links.length&&<div><h3>Related tickets</h3>{t.links.map(link=><button key={link} className="btn btn-sm" onClick={()=>onSelect(link)}>Open related ticket</button>)}</div>}<Suspense fallback={<p>Loading workflow controls…</p>}>{t.staff&&<WorkflowRuns ticketId={id}/>}</Suspense><SupportResolution taskId={t.work.id} onChanged={()=>void q.refetch()}/>
    {edit&&<WorkTaskModal taskId={t.work.id} onClose={()=>{setEdit(false);void q.refetch();}}/>}</div>}</Modal>;
}

function TicketMetadata({ticket,onSaved}:{ticket:Ticket;onSaved:()=>void}){
  const teams=useWsQuery(['teams'],teamApi.list);
  const [category,setCategory]=useState(ticket.category);
  const [region,setRegion]=useState(ticket.region);
  const [language,setLanguage]=useState(ticket.language);
  const [teamId,setTeamId]=useState(ticket.teamId??'');
  const [fields,setFields]=useState(()=>Object.entries(ticket.customFields).map(([key,value])=>({key,value})));
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  return <details className="support-actions"><summary>Routing details and custom fields</summary><form className="support-form" onSubmit={e=>{
    e.preventDefault();setError(null);
    const normalized=fields.map(f=>({key:f.key.trim(),value:f.value}));
    if(normalized.some(f=>!f.key)||new Set(normalized.map(f=>f.key)).size!==normalized.length){setError('Use a unique, non-empty name for each custom field.');return;}
    setBusy(true);void api('PUT','/support/tickets/'+ticket.id+'/metadata',{version:ticket.version,category,region,language,teamId:teamId||null,customFields:Object.fromEntries(normalized.map(f=>[f.key,f.value]))})
      .then(onSaved).catch(e=>setError(e instanceof Error?e.message:'Could not save routing details.')).finally(()=>setBusy(false));
  }}>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <label>Category<input maxLength={120} value={category} onChange={e=>setCategory(e.target.value)}/></label>
    <label>Region<input maxLength={80} value={region} onChange={e=>setRegion(e.target.value)}/></label>
    <label>Language<input maxLength={30} value={language} onChange={e=>setLanguage(e.target.value)}/></label>
    <label>Support team<select value={teamId} onChange={e=>setTeamId(e.target.value)}><option value="">Unassigned</option>{teams.data?.map(team=><option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
    {teams.error&&<p role="alert">Teams could not be loaded. Reload before changing the support team.</p>}
    {fields.map((field,index)=><fieldset key={index}><legend>Custom field {index+1}</legend>
      <label>Name<input required maxLength={80} value={field.key} onChange={e=>setFields(fields.map((f,i)=>i===index?{...f,key:e.target.value}:f))}/></label>
      <label>Value<input maxLength={1000} value={field.value} onChange={e=>setFields(fields.map((f,i)=>i===index?{...f,value:e.target.value}:f))}/></label>
      <button type="button" className="btn btn-sm" onClick={()=>setFields(fields.filter((_,i)=>i!==index))}>Remove field</button>
    </fieldset>)}
    <button type="button" className="btn btn-sm" disabled={busy||fields.length>=20} onClick={()=>setFields([...fields,{key:'',value:''}])}>Add custom field</button>
    <small>Custom fields are staff-only. These details support workflow conditions; assignment is managed separately.</small>
    <button className="btn" disabled={busy}>{busy?'Saving…':'Save routing details'}</button>
  </form></details>;
}
function TicketThread({ticket,onReload}:{ticket:Ticket;onReload:()=>void}){
  const [offset,setOffset]=useState(0);
  const history=useWsQuery(['support','messages',ticket.id,ticket.version,offset],
    ()=>api<{items:Interaction[];nextOffset:number|null}>('GET','/support/tickets/'+ticket.id+'/messages'+qs({version:ticket.version,offset})));
  return <section aria-label="Ticket interactions">
    {history.isLoading?<PageLoader/>:history.error?<ErrorState error={history.error} retry={onReload}/>:
      <div className="support-thread">{!history.data?.items.length&&<p>No replies yet.</p>}{history.data?.items.map(m=>
        <article key={m.id} className={m.visibility==='internal'?'internal':''}><header><b>{m.visibility==='internal'?'Staff note':'Reply'}</b><time>{new Date(m.createdAt).toLocaleString()}</time></header><p>{m.body}</p></article>)}</div>}
    <nav className="support-pagination" aria-label="Conversation history">
      <button className="btn" disabled={history.isLoading||history.data?.nextOffset==null} onClick={()=>setOffset(history.data!.nextOffset!)}>Older replies</button>
      <span aria-live="polite">{offset===0?'Latest replies':'Earlier replies'}</span>
      <button className="btn" disabled={history.isLoading||offset===0} onClick={()=>setOffset(Math.max(0,offset-50))}>Newer replies</button>
    </nav>
  </section>;
}
function SupportMetrics(){
  const summary=useWsQuery(['support','summary'],()=>api<{backlog:number;unassigned:number;handoffs:number;openBreached:number;resolutionMet:number;resolutionMissed:number;responseMet:number;responseMissed:number}>('GET','/support/tickets/summary'));
  if(summary.isLoading)return <p role="status">Loading support metrics…</p>;
  if(summary.error)return <ErrorState error={summary.error} retry={()=>void summary.refetch()}/>;
  const s=summary.data;if(!s)return null;
  const resolved=s.resolutionMet+s.resolutionMissed;
  const responded=s.responseMet+s.responseMissed;
  return <section className="support-metrics" aria-label="Authorized support metrics">
    {[['Backlog',s.backlog],['Unassigned',s.unassigned],['Human handoffs',s.handoffs],['Open SLA breaches',s.openBreached],
      ['Resolution SLA',resolved?Math.round(s.resolutionMet/resolved*100)+'%':'No measured completions'],
      ['Response SLA',responded?Math.round(s.responseMet/responded*100)+'%':'No measured responses']].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    <small>All visible tickets. SLA percentages use recorded outcomes with targets; cancelled work is excluded.</small>
  </section>;
}