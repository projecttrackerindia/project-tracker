import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Background, Controls, MarkerType, ReactFlow, ReactFlowProvider, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../../api/client';
import { workspaceApi } from '../../api/endpoints';
import { ErrorState, PageLoader } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { useCan, useEntitlement } from '../../stores/auth';
import { confirmDialog } from '../../stores/ui';
import './supportWorkflowStudio.css';

type Kind='start'|'condition'|'note'|'handoff'|'assign'|'wait'|'approval'|'end';
type WorkflowNode={id:string;type:Kind;label:string;next:string|null;otherwise:string|null;field:string|null;value:string|null;minutes:number;x:number;y:number};
type Graph={trigger:string;nodes:WorkflowNode[]};
type Workflow={id:string;name:string;graph:Graph;enabled:boolean;publishedRevisionId:string|null;version:number;revisions:{id:string;number:number;createdAt:string}[]};
type Approval={kind:string;label:string;userId:string|null;userName:string|null;reason:string|null;waitMinutes:number;stale:boolean};
type Run={id:string;workflowId:string;ticketId:string;nodeId:string;status:string;version:number;errorCode:string|null;availableAt:string;revisionNumber:number;approval:Approval|null;steps:{nodeId:string;outcome:string;createdAt:string}[]};
type Schedule={id:string;workflowId:string;intervalMinutes:number;nextRunAt:string;enabled:boolean};
const root='/support/workflows';
const kinds:Kind[]=['start','condition','note','approval','handoff','assign','wait','end'];
const triggers=[['manual','Run on demand'],['ticket_created','Ticket created'],['message_received','Public reply received'],['state_changed','Ticket state changed'],['assignment_changed','Assignee changed'],['priority_changed','Priority changed'],['sla_breach','SLA target breached'],['schedule','Scheduled ticket review']];
const makeNode=(id:string,type:Kind,label:string,y:number,next:string|null=null):WorkflowNode=>({id,type,label,next,otherwise:null,field:null,value:null,minutes:5,x:180,y});
const blank=():Graph=>({trigger:'manual',nodes:[makeNode('start','start','Start',0,'note'),{...makeNode('note','note','Add staff note',130,'end'),value:'This ticket is ready for triage.'},makeNode('end','end','Finish',260)]});
function escalationGraph(first:string,second:string,minutes:number):Graph{
  const nodes:WorkflowNode[]=[makeNode('start','start','SLA breach',0,'l1_resolved')];
  const states=['resolved','closed','cancelled','merged'];
  [first,second].forEach((person,index)=>{
    const level='l'+(index+1);const base=index*950+130;
    states.forEach((state,step)=>nodes.push({...makeNode(level+'_'+state,'condition','Stop if '+state,base+step*110,'end'),
      field:'state',value:state,otherwise:step<3?level+'_'+states[step+1]:level+'_review'}));
    nodes.push({...makeNode(level+'_review','approval','Review escalation level '+(index+1),base+440,level+'_assign'),otherwise:'end'});
    nodes.push({...makeNode(level+'_assign','assign','Assign escalation level '+(index+1),base+570,index===0?'wait':'end'),value:person});
    if(index===0)nodes.push({...makeNode('wait','wait','Wait before next escalation',base+700,'l2_resolved'),minutes});
  });
  nodes.push({...makeNode('end','end','Finish',2100),x:650});
  return {trigger:'sla_breach',nodes};
}
const errorMessage=(e:unknown)=>e instanceof Error?e.message:'Could not complete this action.';
function useWorkflowAccess(){const plan=useEntitlement('AUTOMATION')!==0;const manage=useCan('workflow.manage');const work=useCan('work.edit');return {plan,manage,allowed:plan&&manage&&work};}

export function SupportWorkflowStudio(){
  const [firstLevel,setFirstLevel]=useState('');const [secondLevel,setSecondLevel]=useState('');const [escalationMinutes,setEscalationMinutes]=useState(60);
  const access=useWorkflowAccess();const qc=useQueryClient();
  const q=useWsQuery(['support','workflows'],()=>api<Workflow[]>('GET',root),{enabled:access.allowed});
  const people=useWsQuery(['members'],()=>workspaceApi.members(),{enabled:access.allowed});
  const [current,setCurrent]=useState<Workflow|null>(null);const [graph,setGraph]=useState<Graph>(blank);const [name,setName]=useState('Support triage');const [selected,setSelected]=useState('note');
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [message,setMessage]=useState('');
  const dirty=!current||name!==current.name||JSON.stringify(graph)!==JSON.stringify(current.graph);
  const node=graph.nodes.find(n=>n.id===selected);
  async function act(fn:()=>Promise<void>){setBusy(true);setError(null);setMessage('');try{await fn();await qc.invalidateQueries({predicate:q=>q.queryKey.includes('support')});}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  async function load(w:Workflow|null){if(dirty&&!await confirmDialog({title:'Discard unsaved workflow changes?',message:'Save the workflow first to keep your changes.',confirmText:'Discard'}))return;setCurrent(w);setName(w?.name??'Support triage');setGraph(w?.graph??blank());setSelected(w?.graph.nodes[0]?.id??'note');setError(null);setMessage('');}
  function patch(changes:Partial<WorkflowNode>){setGraph(g=>({...g,nodes:g.nodes.map(n=>n.id===selected?{...n,...changes}:n)}));}
  function position(changes:NodeChange[]){setGraph(g=>({...g,nodes:g.nodes.map(n=>{const move=changes.find(c=>c.type==='position'&&c.id===n.id);return move?.type==='position'&&move.position?{...n,x:move.position.x,y:move.position.y}:n;})}));}
  if(!access.plan)return <div className="notice">Your current plan does not include support automation. <Link to="/settings/billing">Review plans</Link>.</div>;
  if(!access.allowed)return <div className="notice">Workflow management and Operations edit permissions are required to configure support workflows.</div>;
  if(q.isLoading)return <PageLoader/>;
  if(q.error)return <ErrorState error={q.error} retry={()=>void q.refetch()}/>;
  const connection=(key:'next'|'otherwise',label:string)=><label>{label}<select value={node?.[key]??''} onChange={e=>patch({[key]:e.target.value||null})}><option value="">Choose next node</option>{graph.nodes.filter(n=>n.id!==selected).map(n=><option key={n.id} value={n.id}>{n.label} · {n.id}</option>)}</select></label>;
  return <section className="workflow-studio"><div className="workflow-studio-heading"><div><h2>Workflow studio</h2><p>Design bounded support workflows. Publish an immutable revision, review approvals and recover failed runs.</p></div><button className="btn" disabled={busy} onClick={()=>void load(null)}><Icon name="plus"/>New workflow</button></div>
    {error&&<p role="alert" className="form-error">{error}</p>}{message&&<p role="status">{message}</p>}
    <details className="support-actions"><summary>Create a staged SLA escalation draft</summary>
      <p>Choose two reviewed recipients. Each stage stops for resolved or closed work and requires a fresh approval before changing ownership. The draft initially matches workspace SLA breaches; add team or category conditions to narrow it before publishing.</p>
      <div className="workflow-designer-toolbar">
        <label>First escalation recipient<select value={firstLevel} onChange={e=>setFirstLevel(e.target.value)}><option value="">Choose recorded lead</option>{people.data?.map(p=><option key={p.userId} value={p.userId}>{p.displayName}</option>)}</select></label>
        <label>Second escalation recipient<select value={secondLevel} onChange={e=>setSecondLevel(e.target.value)}><option value="">Choose recorded manager</option>{people.data?.map(p=><option key={p.userId} value={p.userId}>{p.displayName}</option>)}</select></label>
        <label>Minutes between stages<input type="number" min={1} max={10080} value={escalationMinutes} onChange={e=>setEscalationMinutes(Number(e.target.value))}/></label>
        <button className="btn" disabled={busy||!firstLevel||!secondLevel||firstLevel===secondLevel||!Number.isInteger(escalationMinutes)||escalationMinutes<1||escalationMinutes>10080} onClick={()=>void(async()=>{
          if(dirty&&!await confirmDialog({title:'Replace unsaved workflow draft?',message:'This creates a new escalation draft. Save your current changes first to keep them.',confirmText:'Replace draft'}))return;
          setCurrent(null);setName('Staged SLA escalation');setGraph(escalationGraph(firstLevel,secondLevel,escalationMinutes));setSelected('l1_review');setError(null);setMessage('Escalation draft created. Review recipients, conditions and timing, then save and publish.');
        })()}>Create escalation draft</button>
      </div>
      <small>Recipients are selected explicitly; the system does not invent a reporting hierarchy. Use the ticket routing preview to review recorded leads and managers.</small>
    </details>
    <div className="workflow-editor-layout"><aside className="workflow-library"><h3>Saved workflows</h3>{!q.data?.length&&<p>No workflows yet. Start with the draft shown here.</p>}{q.data?.map(w=><button className={`workflow-library-row ${current?.id===w.id?'selected':''}`} disabled={busy} key={w.id} onClick={()=>void load(w)}><Icon name="workflow"/><span>{w.name}<small>{w.enabled?'Published':'Disabled or draft'} · v{w.version}</small></span></button>)}
      {current&&<details><summary>Published revisions</summary>{current.revisions.map(r=><div key={r.id}><span>Revision {r.number} · {new Date(r.createdAt).toLocaleDateString()}</span><button className="btn btn-sm" disabled={busy||dirty} onClick={()=>void act(async()=>{if(!await confirmDialog({title:'Restore this revision?',message:'This creates a new published revision from the saved graph. Pending runs of the previous revision will stop before their next action.',confirmText:'Restore revision'}))return;const w=await api<Workflow>('POST',`${root}/${current.id}/publish`,{version:current.version,restoreRevision:r.number});setCurrent(w);setGraph(w.graph);setMessage('The selected revision was restored as a new publication.');})}>Restore</button></div>)}</details>}
    </aside><div className="workflow-designer"><div className="workflow-designer-toolbar"><label>Workflow name<input value={name} maxLength={120} onChange={e=>setName(e.target.value)}/></label><label>Trigger<select value={graph.trigger} onChange={e=>setGraph({...graph,trigger:e.target.value})}>{triggers.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><button className="btn btn-sm" disabled={busy||graph.nodes.length>=40} onClick={()=>{const id='n'+crypto.randomUUID().replaceAll('-','').slice(0,8);setGraph({...graph,nodes:[...graph.nodes,makeNode(id,'note','New step',graph.nodes.length*130)]});setSelected(id);}}>Add step</button></div>
      <div className="workflow-canvas"><ReactFlowProvider><ReactFlow nodes={graph.nodes.map(n=>({id:n.id,position:{x:n.x,y:n.y},data:{label:<><b>{n.label}</b><small>{n.type}</small></>},style:{borderColor:n.id===selected?'#7c3aed':undefined,borderRadius:12}}))} edges={graph.nodes.flatMap(n=>[n.next?{id:n.id+'-next',source:n.id,target:n.next,label:n.type==='condition'?'Match':n.type==='approval'?'Approve':undefined,markerEnd:{type:MarkerType.ArrowClosed}}:null,n.otherwise?{id:n.id+'-other',source:n.id,target:n.otherwise,label:n.type==='approval'?'Reject':'No match',markerEnd:{type:MarkerType.ArrowClosed}}:null].filter(e=>e!==null))} onNodesChange={position} onNodeClick={(_,n)=>setSelected(n.id)} nodesConnectable={false} deleteKeyCode={null} fitView fitViewOptions={{padding:.25}} minZoom={.2} maxZoom={1.5} aria-label="Support workflow canvas"><Background/><Controls showInteractive={false}/></ReactFlow></ReactFlowProvider></div>
      <p className="support-note">Connect every step to an end. Loops and arbitrary code are rejected. Each assignment or handoff requires its own approval. Drag nodes to arrange the canvas or select a step below.</p><div className="workflow-node-picker">{graph.nodes.map(n=><button className="btn btn-sm" aria-pressed={selected===n.id} key={n.id} onClick={()=>setSelected(n.id)}>{n.label}</button>)}</div>
    </div><aside className="workflow-inspector"><h3>Step settings</h3>{node&&<><label>Label<input maxLength={100} value={node.label} onChange={e=>patch({label:e.target.value})}/></label><label>Type<select value={node.type} onChange={e=>patch({type:e.target.value as Kind,next:e.target.value==='end'?null:node.next,otherwise:['condition','approval'].includes(e.target.value)?node.otherwise:null})}>{kinds.map(k=><option key={k}>{k}</option>)}</select></label>{node.type!=='end'&&connection('next',node.type==='approval'?'On approval':node.type==='condition'?'On match':'Next step')}{['condition','approval'].includes(node.type)&&connection('otherwise',node.type==='approval'?'On rejection':'On no match')}
      {node.type==='condition'&&<><label>Field<select value={node.field??''} onChange={e=>patch({field:e.target.value})}><option value="">Choose field</option>{['category','region','language','state','priority','team','project'].map(f=><option key={f}>{f}</option>)}</select></label><label>Exact value<input maxLength={120} value={node.value??''} onChange={e=>patch({value:e.target.value})}/></label></>}
      {['note','handoff'].includes(node.type)&&<label>{node.type==='note'?'Private staff note':'Handoff reason'}<textarea maxLength={1000} rows={5} value={node.value??''} onChange={e=>patch({value:e.target.value})}/></label>}
      {node.type==='assign'&&<label>Assignee<select value={node.value??''} onChange={e=>patch({value:e.target.value})}><option value="">Choose workspace member</option>{people.data?.map(p=><option key={p.userId} value={p.userId}>{p.displayName}</option>)}</select></label>}
      {node.type==='wait'&&<label>Wait in minutes<input type="number" min={1} max={10080} value={node.minutes} onChange={e=>patch({minutes:Number(e.target.value)})}/></label>}
      <button className="btn btn-sm" disabled={busy} onClick={()=>{setGraph({...graph,nodes:graph.nodes.filter(n=>n.id!==node.id).map(n=>({...n,next:n.next===node.id?null:n.next,otherwise:n.otherwise===node.id?null:n.otherwise}))});setSelected(graph.nodes.find(n=>n.id!==node.id)?.id??'');}}>Remove step</button></>}
      <hr/><button className="btn btn-primary" disabled={busy||!dirty} onClick={()=>void act(async()=>{const w=await api<Workflow>(current?'PUT':'POST',current?`${root}/${current.id}`:root,{name,graph,version:current?.version??0});setCurrent(w);setGraph(w.graph);setMessage('Draft saved. Publish it to activate the trigger.');})}>Save draft</button>
      <button className="btn" disabled={busy||dirty||!current} onClick={()=>void act(async()=>{if(!current||!await confirmDialog({title:'Publish support workflow?',message:'Matching events may add private staff notes automatically. Assignments and handoffs pause for explicit approval. Execution uses the publisher’s current permissions. Publishing a new revision stops pending actions from older revisions.',confirmText:'Publish workflow'}))return;const w=await api<Workflow>('POST',`${root}/${current.id}/publish`,{version:current.version});setCurrent(w);setGraph(w.graph);setMessage('Workflow published. Review its executions in each ticket.');})}>Publish</button>
      {current?.enabled&&<button className="btn" disabled={busy} onClick={()=>void act(async()=>{await api('POST',`${root}/${current.id}/disable?version=${current.version}`);setCurrent({...current,enabled:false,version:current.version+1});setMessage('Workflow disabled. Pending runs stop before their next action.');})}>Disable workflow</button>}
    </aside></div>
  </section>;
}

export function TicketWorkflowRuns({ticketId}:{ticketId:string}){
  const {allowed}=useWorkflowAccess();const qc=useQueryClient();const [workflow,setWorkflow]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [minutes,setMinutes]=useState(60);const attempt=useRef<{workflow:string;key:string}|null>(null);
  const definitions=useWsQuery(['support','workflows'],()=>api<Workflow[]>('GET',root),{enabled:allowed});
  const runs=useWsQuery(['support','runs',ticketId],()=>api<Run[]>('GET',`${root}/runs?ticketId=${ticketId}`),{enabled:allowed,refetchInterval:5000});
  const schedules=useWsQuery(['support','schedules',ticketId],()=>api<Schedule[]>('GET',`${root}/schedules?ticketId=${ticketId}`),{enabled:allowed});
  async function act(fn:()=>Promise<void>){setBusy(true);setError(null);try{await fn();await qc.invalidateQueries({predicate:q=>q.queryKey.includes('support')||q.queryKey.includes('work')});}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  if(!allowed)return null;
  return <details className="support-actions"><summary>Workflow runs & schedules</summary>{error&&<p role="alert" className="form-error">{error}</p>}{(definitions.error||runs.error||schedules.error)&&<p role="alert">{definitions.error?.message??runs.error?.message??schedules.error?.message}</p>}
    <div className="support-form"><label>Published workflow<select value={workflow} onChange={e=>setWorkflow(e.target.value)}><option value="">Choose workflow</option>{definitions.data?.filter(w=>w.enabled).map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label><button className="btn" disabled={busy||!workflow} onClick={()=>void act(async()=>{if(!attempt.current||attempt.current.workflow!==workflow)attempt.current={workflow,key:crypto.randomUUID()};await api('POST',`${root}/${workflow}/runs`,{ticketId,requestKey:attempt.current.key});attempt.current=null;})}>Run on this ticket</button>
      {definitions.data?.find(w=>w.id===workflow)?.graph.trigger==='schedule'&&<><label>Every (minutes)<input type="number" min={5} max={10080} value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/></label><button className="btn" disabled={busy} onClick={()=>void act(async()=>{await api('POST',`${root}/${workflow}/schedules?ticketId=${ticketId}&intervalMinutes=${minutes}`);})}>Create schedule</button></>}
    </div>{schedules.data?.map(s=><div key={s.id} className="workflow-run"><p>{s.enabled?'Scheduled':'Disabled'} · every {s.intervalMinutes} min · next {new Date(s.nextRunAt).toLocaleString()}</p><button className="btn btn-sm" disabled={busy} onClick={()=>void act(async()=>{await api('DELETE',`${root}/schedules/${s.id}`);})}>Remove schedule</button></div>)}
    {runs.isLoading&&<p>Loading workflow runs…</p>}{!runs.data?.length&&<p>No runs for this ticket yet.</p>}{runs.data?.map(r=><article className="workflow-run" key={r.id}><header><b>{definitions.data?.find(w=>w.id===r.workflowId)?.name??'Workflow'}</b><span className="badge badge-neutral">{r.status}</span></header><p>Current step: {r.nodeId}{r.errorCode?' · '+r.errorCode:''}</p>{r.status==='approval'&&<><p>Published revision {r.revisionNumber} · {r.approval?.label}</p>{r.approval?.userName&&<p>Assign to: <b>{r.approval.userName}</b></p>}{r.approval?.reason&&<p>Handoff reason: {r.approval.reason}</p>}{!!r.approval?.waitMinutes&&<p>The action follows a {r.approval.waitMinutes} minute wait.</p>}{r.approval?.stale&&<p role="alert">The ticket, assignee or workflow changed. Cancel this run and start a fresh review.</p>}<button className="btn btn-sm btn-primary" disabled={busy||!r.approval||r.approval.stale} onClick={()=>void act(async()=>{if(!await confirmDialog({title:'Approve workflow action?',message:r.approval?.kind==='assign'?`Assign this ticket to ${r.approval.userName}. Current permissions and ticket versions will be checked again.`:r.approval?.kind==='handoff'?`Hand off this ticket for human review: ${r.approval.reason}`:'Continue this workflow to its next review or finish.',confirmText:'Approve'}))return;await api('POST',`${root}/runs/${r.id}/decide`,{version:r.version,accepted:true});})}>Approve</button><button className="btn btn-sm" disabled={busy} onClick={()=>void act(async()=>{await api('POST',`${root}/runs/${r.id}/decide`,{version:r.version,accepted:false});})}>Reject</button></>}
      {r.status==='failed'&&r.errorCode!=='WORKFLOW_APPROVAL_STALE'&&<button className="btn btn-sm" disabled={busy} onClick={()=>void act(async()=>{await api('POST',`${root}/runs/${r.id}/retry?version=${r.version}`);})}>Retry failed step</button>}{!['succeeded','cancelled'].includes(r.status)&&<button className="btn btn-sm" disabled={busy} onClick={()=>void act(async()=>{await api('POST',`${root}/runs/${r.id}/cancel?version=${r.version}`);})}>Cancel run</button>}
      {!!r.steps.length&&<details><summary>Execution history</summary><ol>{r.steps.map(s=><li key={s.nodeId}>{s.nodeId} · {s.outcome} · {new Date(s.createdAt).toLocaleString()}</li>)}</ol></details>}
    </article>)}
  </details>;
}