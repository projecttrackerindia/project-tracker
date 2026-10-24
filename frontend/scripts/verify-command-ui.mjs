import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// The Command Center and the agent's autonomy against the built frontend and synthetic API fixtures only. No live meetings, mail or AI.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/command-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const pid='00000000-0000-0000-0000-000000000003';
const project={id:pid,key:'PAY',name:'Payments Core',description:'Payment gateway and settlement.',status:'Active',priority:'High',health:'AtRisk',progress:46,active:4,startDate:'2030-01-01',dueDate:'2030-01-20',version:3,stageScheduleMode:'Manual',projectType:'NewProject',deliveryMethod:'Agile',owner:{id:user.id,name:user.displayName},stats:{total:12,done:5,inProgress:4,cancelled:0,todo:3,overdue:2}};
const detail={project,stages:[],statuses:[{id:pid,name:'To Do',order:0,category:'Todo',color:'#4f46e5'}],members:[{userId:user.id,name:user.displayName,email:user.email,role:'Owner'}]};
const soon=(min)=>new Date(Date.now()+min*60000).toISOString();
const meetings=[
  {id:'m1:1',meetingId:'m1',projectId:pid,projectKey:'PAY',projectName:'Payments Core',title:'Payments stand-up',startUtc:soon(40),endUtc:soon(55),meetUrl:'https://meet.google.com/abc-defg-hij',organizer:false,project:true,agentEnabled:true,agentAttending:false,delegationId:null,delegationStatus:null,overlapsWith:['Client escalation']},
  {id:'cal:1',meetingId:null,projectId:null,projectKey:null,projectName:null,title:'Client escalation',startUtc:soon(40),endUtc:soon(70),meetUrl:'https://meet.google.com/xyz-abcd-efg',organizer:false,project:false,agentEnabled:false,agentAttending:false,delegationId:null,delegationStatus:null,overlapsWith:['Payments stand-up']},
  {id:'m2:1',meetingId:'m2',projectId:pid,projectKey:'PAY',projectName:'Payments Core',title:'UAT review',startUtc:soon(180),endUtc:soon(210),meetUrl:'https://meet.google.com/uat-revi-ewx',organizer:true,project:true,agentEnabled:true,agentAttending:true,delegationId:'d1',delegationStatus:'attending',overlapsWith:[]},
];
const commitment={id:'c1',projectId:pid,projectKey:'PAY',projectName:'Payments Core',entityKey:'PAY-31',taskId:'t31',title:'API validation with the bank',dueDate:'2030-01-08',owner:{id:user.id,name:user.displayName},status:'open',quote:"I'll finish API validation by tomorrow 3 PM",sourceLabel:'Stand-up · 07 Jan',checkInSentAt:'2030-01-08T04:30:00Z',checkInAnswer:null,checkInNote:null,proposedDate:null,answeredAt:null,awaitingAnswer:true};
const delegation={id:'d1',projectId:pid,projectKey:'PAY',projectName:'Payments Core',meetingId:'m2',title:'UAT review',startUtc:soon(180),endUtc:soon(210),status:'attending',instructions:'Ask whether refunds can ship on Friday.',automatic:false,botStatus:'joining',botError:null,reportSentAt:null,summary:null,outcomes:[],toDecide:0,canDecide:true,note:null};
const center={greeting:'Good morning, Asha',headline:'5 things need your attention, 3 urgent: Upendra asks to move PAY-12 to 22 Jan; Is PAY-31 on track?.',since:'2030-01-07T12:00:00Z',
  counts:{attention:5,toDecide:6,dueToday:1,overdue:2,blocking:1,checkIns:1,meetingsToday:3,atRisk:1},
  attention:[
    {id:'cr:1',kind:'change_request',severity:'high',title:'Upendra asks to move PAY-12 to 22 Jan',detail:null,why:['“Bank sandbox keys arrive on Friday.” - Check-in from Upendra · 08 Jan','Moving PAY-12 by 2 days moves 3 dependent tasks (PAY-14, PAY-15, PAY-18); the project would finish 1 day after its due date (20 Jan).'],link:`/projects/${pid}?tab=agent`,projectId:pid,projectKey:'PAY',entityId:'f9',action:'decide',actionAt:null},
    {id:'ci:1',kind:'check_in',severity:'high',title:'Is PAY-31 on track?',detail:'API validation with the bank',why:['you said “I\'ll finish API validation by tomorrow 3 PM”','Stand-up · 07 Jan'],link:null,projectId:pid,projectKey:'PAY',entityId:'c1',action:'check_in',actionAt:null},
    {id:'double:1',kind:'double_booked',severity:'high',title:'Double-booked: Payments stand-up',detail:'overlaps Client escalation',why:['the agent can attend as your assistant and report back'],link:null,projectId:pid,projectKey:'PAY',entityId:'m1',action:'delegate',actionAt:meetings[0].startUtc},
    {id:'blocking:1',kind:'blocking',severity:'medium',title:'PAY-9 is holding up 2 tasks',detail:'Settlement file format',why:['waiting: PAY-12 (Upendra), PAY-14 (Jyothsna)','your date: Tue 7 Jan'],link:`/projects/${pid}`,projectId:pid,projectKey:'PAY',entityId:'t9',action:'open',actionAt:null},
    {id:'decide:1',kind:'decide',severity:'medium',title:'5 proposals from the agent in Payments Core',detail:null,why:['2 new task, 1 delay, 2 decision','oldest waiting 1 day'],link:`/projects/${pid}?tab=agent`,projectId:pid,projectKey:'PAY',entityId:null,action:'review',actionAt:null},
  ],
  today:meetings,
  changes:[{kind:'done',text:'4 tasks finished: PAY-3, PAY-5, PAY-6, PAY-8',link:null,at:'2030-01-08T03:00:00Z',projectKey:null},{kind:'decision',text:'Decision: Launch in two phases',link:`/projects/${pid}?tab=agent`,at:'2030-01-08T02:00:00Z',projectKey:'PAY'},{kind:'auto',text:'The agent added PAY-33',link:`/projects/${pid}?tab=agent`,at:'2030-01-08T01:00:00Z',projectKey:'PAY'}],
  health:[{projectId:pid,key:'PAY',name:'Payments Core',level:'high',score:72,reasons:['2 tasks overdue','due date moved twice'],progress:46,overdueTasks:2,dueDate:'2030-01-20',projectedFinish:'2030-01-23',slipDays:3,kept:5,missed:2}],
  reliability:{kept:9,missed:2,open:3,moved:1},checkIns:[commitment],
  owe:[{id:'t9',projectId:pid,key:'PAY-9',title:'Settlement file format',due:'2030-01-07',state:'overdue',daysLate:1,waiting:['PAY-12 (Upendra)','PAY-14 (Jyothsna)']},{id:'t31',projectId:pid,key:'PAY-31',title:'API validation with the bank',due:'2030-01-08',state:'due_today',daysLate:null,waiting:[]}],
  delegations:[delegation]};
const impact={taskId:'t12',projectId:pid,key:'PAY-12',title:'Gateway integration',oldDue:'2030-01-15',newDue:'2030-01-18',slipDays:3,
  moves:[{id:'t14',key:'PAY-14',title:'Bank certification',owner:'Jyothsna Reddy',oldDue:'2030-01-17',newDue:'2030-01-20',shiftDays:3,depth:1},{id:'t18',key:'PAY-18',title:'Go live',owner:'Upendra Rao',oldDue:'2030-01-19',newDue:'2030-01-22',shiftDays:3,depth:2}],
  milestones:['UAT sign-off (due 19 Jan) would be missed by 1 day'],projectDue:'2030-01-20',newFinish:'2030-01-22',projectSlipDays:2,people:['Jyothsna Reddy','Upendra Rao'],summary:'Moving PAY-12 by 3 days moves 2 dependent tasks (PAY-14, PAY-18); the project would finish 2 days after its due date (20 Jan); 1 milestone would be missed.',level:'high'};
const brief={meetingId:'m1',projectId:pid,projectKey:'PAY',projectName:'Payments Core',title:'Payments stand-up',startUtc:meetings[0].startUtc,endUtc:meetings[0].endUtc,meetUrl:meetings[0].meetUrl,
  headline:'Since the last meeting: 7 actions - 4 done, 2 late, 1 blocked, 0 open.',actionsSinceLast:7,done:4,overdue:2,blocked:1,open:0,
  items:[{key:'PAY-12',owner:'Upendra',due:'2030-01-07',state:'blocked'},{key:'PAY-9',owner:'Asha',due:'2030-01-06',state:'overdue'},{key:'PAY-3',owner:'Ravi',due:'2030-01-05',state:'done'}],
  blockers:['PAY-9 (Asha, 2d late) holds up PAY-12, PAY-14'],commitments:['PAY-31 (Asha) today'],agenda:['Unblock PAY-9','Late work: PAY-9 (Asha), PAY-11 (Ravi)','2 proposals waiting for a decision'],pendingDecisions:2,maybeUnnecessary:false,lastMeetingAt:'2030-01-07T04:00:00Z',agentAttending:false};
let settings={autoDelegate:false,meetingBriefs:true,briefMinutes:10,checkIns:true,googleConnected:true};
let agent={projectId:pid,enabled:true,readMailbox:true,readChat:true,readMeetings:true,liveBot:true,dailyUpdates:true,mailboxAddress:'agent+0a1b2c3d4e5f60718293a4b5@inbound.projecttracker.in',liveBotAvailable:true,aiAvailable:true,
  pending:0,lastRunAt:null,lastError:null,runsThisMonth:4,monthlyRunLimit:300,canManage:true,actingUserName:'Asha Rao',runs:[],transcriptAccess:false,instructions:null,speakerAliases:null,autoTranscriptAccess:false,
  captionLanguage:null,autoJoinCalendar:false,sendMinutes:true,slackChannelId:null,slackAvailable:false,readWhatsApp:true,whatsAppAvailable:false,autonomyLevel:4,autoApplyConfidence:90,autoApplyKinds:['CreateActionItem','Decision','Suggestion','Missed'],followUps:true,meetingBriefs:true};
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 // home: 'classic' starts on the classic Home (the person chose it once); null keeps the default, which is the AI-first Home.
 const make=async(theme,home='classic')=>{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(([t,h])=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme',t);if(h&&!localStorage.getItem('pm_home_mode'))localStorage.setItem('pm_home_mode',h);},[theme,home]);
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  const body=()=>{try{return req.postDataJSON();}catch{return null;}};
  if(ep==='/api/v1/agent/command-center')data=center;
  else if(ep==='/api/v1/agent/commitments/c1')data=commitment;
  else if(ep==='/api/v1/agent/commitments/c1/check-in'&&method==='POST'){const b=body();writes.push({ep,b});data={...commitment,checkInAnswer:b.answer,checkInNote:b.note??null,proposedDate:b.newDate??null,answeredAt:'2030-01-08T05:00:00Z',awaitingAnswer:false};}
  else if(ep==='/api/v1/agent/meetings')data=meetings;
  else if(ep==='/api/v1/agent/delegations'&&method==='POST'){const b=body();writes.push({ep,b});data={...delegation,id:'d2',meetingId:b.meetingId,title:'Payments stand-up',status:'requested',instructions:b.instructions??null};}
  else if(ep==='/api/v1/agent/delegations')data=[delegation];
  else if(ep==='/api/v1/agent/delegations/d1')data=delegation;
  else if(ep==='/api/v1/agent/meetings/m1/brief')data=brief;
  else if(ep==='/api/v1/agent/me/settings'&&method==='PUT'){const b=body();writes.push({ep,b});settings={...settings,...b};data=settings;}
  else if(ep==='/api/v1/agent/me/settings')data=settings;
  else if(ep==='/api/v1/agent/decisions')data=[{id:'x1',projectId:pid,projectKey:'PAY',projectName:'Payments Core',title:'Launch in two phases',detail:'Cards first, UPI a week later.',evidence:'we launch cards first and UPI a week later',sourceLabel:'Stand-up · 07 Jan',status:'Applied',at:'2030-01-07T05:00:00Z',decidedBy:{id:user.id,name:user.displayName},decidedAt:'2030-01-07T06:00:00Z',taskKey:null}];
  else if(ep==='/api/v1/agent/audit')data=[
    {id:'a1',projectId:pid,projectKey:'PAY',kind:'CreateActionItem',action:'Carried out by the agent',title:'Share the bank test plan',key:null,status:'Applied',auto:true,by:{id:user.id,name:user.displayName},at:'2030-01-08T02:00:00Z',confidence:94,before:null,after:'Ravi',evidence:'I will share the test plan',sourceLabel:'Stand-up · 07 Jan',error:null},
    {id:'a2',projectId:pid,projectKey:'PAY',kind:'Delay',action:'Approved',title:'Move PAY-12 to 18 Jan',key:'PAY-12',status:'Applied',auto:false,by:{id:user.id,name:user.displayName},at:'2030-01-08T01:00:00Z',confidence:100,before:'due 2030-01-15 · In progress · Upendra Rao · High',after:'due 2030-01-18',evidence:'sandbox keys arrive Friday',sourceLabel:'Check-in from Upendra',error:null},
    {id:'a3',projectId:pid,projectKey:'PAY',kind:'Suggestion',action:'Dismissed',title:'Add a retry queue',key:null,status:'Dismissed',auto:false,by:{id:user.id,name:user.displayName},at:'2030-01-07T09:00:00Z',confidence:60,before:null,after:null,evidence:null,sourceLabel:'Project chat',error:null}];
  else if(ep===`/api/v1/agent/what-if/projects/${pid}/tasks`)data=[{id:'t12',key:'PAY-12',title:'Gateway integration',due:'2030-01-15',owner:'Upendra Rao',dependents:2},{id:'t9',key:'PAY-9',title:'Settlement file format',due:'2030-01-07',owner:'Asha Rao',dependents:1}];
  else if(ep==='/api/v1/agent/what-if'&&method==='POST'){const b=body();writes.push({ep,b});data={...impact,slipDays:b.slipDays??3};}
  else if(ep===`/api/v1/projects/${pid}/agent`&&method==='PUT'){const b=body();writes.push({ep,b});agent={...agent,...b};data=agent;}
  else if(ep===`/api/v1/projects/${pid}/agent`)data=agent;
  else if(ep===`/api/v1/projects/${pid}/agent/findings`)data={items:[],pending:0,canDecide:true};
  else if(ep===`/api/v1/projects/${pid}/tasks`&&method==='POST'){const b=body();writes.push({ep,b});data={id:'t9',key:'PAY-9',title:b.title};}
  else{
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','tasks.view','tasks.edit','tasks.create','org.manage','work.view','reports.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep===`/api/v1/projects/${pid}/tasks/suggest`)data={assignees:[{userId:user.id,name:user.displayName,why:'1 open, 0 overdue, 0 due this week; 3 similar tasks done before'}],estimateLow:5,estimateHigh:9,estimate:7,estimateWhy:'3 similar finished tasks took 5, 7, 9 h.',dueDate:'2030-01-17',dueWhy:'About 2 working days from today at 6 h a day.',priority:'High',priorityWhy:'3 of 3 similar tasks were High.',similar:[{id:'s1',key:'PAY-3',title:'Bank statement API integration',hours:5,assignee:null},{id:'s2',key:'PAY-5',title:'UPI refund API integration',hours:9,assignee:null}]};
   else if(ep===`/api/v1/projects/${pid}`)data=detail;
   else if(ep===`/api/v1/projects/${pid}/meetings`)data=[];
   else if(ep==='/api/v1/projects')data={items:[project],page:1,totalPages:1,totalItems:1};
   else if(ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
   else if(ep.endsWith('/workspace/members'))data=[{userId:user.id,displayName:user.displayName,email:user.email,role:'Owner'}];
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep==='/api/v1/reports/summary'||ep==='/api/v1/work-tasks/summary')data=null;
   else if(ep==='/api/v1/dashboard')data={counts:{myDueToday:1,myCompletedToday:0,myOpen:3,myOverdue:0,activeProjects:1,completedProjects:0,totalProjects:1,openTasks:6,overdueTasks:1,members:4,overallProgress:42,myLoggedMinutesThisWeek:90},myTasks:[],projects:[],activity:[],myWork:[]};
   else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
   else if(ep.endsWith('/ai/usage'))data={month:'2030-01',creditsUsed:20,creditsLimit:200,creditsLeft:180,unlimited:false,maxTier:'deep',attachments:true,actions:true,tiers:['quick','standard','deep'].map((id,i)=>({id,label:id,model:'synthetic',credits:i+1,allowed:true,description:'Preview mode'})),attachmentTypes:[],maxFiles:3,maxImageMb:2,maxDocumentMb:2,requestLimits:{perMinute:20,perHour:300,perDay:1500}};
   else if(ep.endsWith('/ai/starters'))data={greeting:'Welcome back',starters:[]};
   else if(ep.endsWith('/ai/insights'))data={items:[]};
   else if(ep==='/api/v1/ai/conversations/c1')data={id:'c1',title:'Why is CRIF HIGHMARK delayed?',messages:[
     {id:'m1',role:'user',content:'Why is CRIF HIGHMARK delayed?',reasoning:null,tier:null,model:null,routeReason:null,credits:0,status:'complete',tools:[],actions:[],attachments:[],createdAt:new Date(Date.now()-3600e3).toISOString()},
     {id:'m2',role:'assistant',content:'**CRIF HIGHMARK** is 6 days behind. Two tasks are blocked on the vendor API keys, and the QA estimate grew from 16 to 30 hours.',reasoning:null,tier:'standard',model:'synthetic',routeReason:'Needs project data',credits:2,status:'complete',tools:[],actions:[],attachments:[],createdAt:new Date(Date.now()-3590e3).toISOString()},
     {id:'m3',role:'user',content:"Approve Max's timesheet and then submit my week",reasoning:null,tier:null,model:null,routeReason:null,credits:0,status:'complete',tools:[],actions:[],attachments:[],createdAt:new Date(Date.now()-3500e3).toISOString()},
     {id:'m4',role:'assistant',content:'Both are ready for you to confirm.',reasoning:null,tier:'standard',model:'synthetic',routeReason:'Several parts',credits:2,status:'complete',
      tools:[{name:'show_plan',label:'Planned the steps',count:3,steps:[{title:"Approve Max's timesheet",tool:'propose_review_timesheet',state:'waiting',actionId:'a1'},{title:'Submit your week',tool:'propose_submit_week',state:'waiting',actionId:'a2'},{title:'Tell you what is left',tool:null,state:'done'}]},{name:'needs_you',label:'Looked at what needs you',count:3}],
      actions:[{id:'a1',kind:'review_timesheet',title:"Approve Max Manager's timesheet — week of 12 Jan 2030",summary:'38h logged, 30h billable · the week stays locked for payroll and invoices',status:'done',link:'/timesheet/approvals?week=2030-01-12',error:null,preview:null},
        {id:'a2',kind:'submit_week',title:'Submit your timesheet for the week of 12 Jan 2030',summary:'40h logged (32h billable) · goes to your manager',status:'proposed',link:null,error:null,preview:null}],
      attachments:[],createdAt:new Date(Date.now()-3490e3).toISOString()}]};
   else if(ep==='/api/v1/ai/conversations')data=[{id:'c1',title:'Why is CRIF HIGHMARK delayed?',lastMessageAt:new Date(Date.now()-3600e3).toISOString(),isPinned:false}];
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep==='/api/v1/chat/projects/unread')data=[];
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 return ctx;};
 const noOverflow=(page,what)=>fitsPhone(page,what,assert);
 const shot=async(page,name,full=false)=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,name),animations:'disabled',fullPage:full});};

 // Desktop: what needs me, with the evidence; answer a check-in; send the agent; what if; meetings, brief, settings; decisions; audit.
 let ctx=await make('light');
 let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/command-center?tab=dashboard');await page.locator('.cmd-tabs .tab.active',{hasText:'Dashboard'}).waitFor();await page.locator('.cmd-dashboard').waitFor();await page.locator('.cmd-dashboard .stat-card').first().waitFor();await page.waitForTimeout(400);await page.screenshot({path:path.join(out,'dashboard-1440.png'),fullPage:true,animations:'disabled'});checks.push('dashboard-first');await page.goto(origin+'/preview-org/command-center?tab=today');
 await page.getByRole('heading',{name:'Good morning, Asha'}).waitFor();
 assert.equal(await page.locator('[data-attention]').count(),5);
 assert.ok(await page.getByText('moves 3 dependent tasks',{exact:false}).isVisible());checks.push('attention-with-evidence');
 assert.ok(await page.getByRole('link',{name:'Home'}).first().isVisible());checks.push('nav-entry');
 await shot(page,'command-1440.png',true);await noOverflow(page,'command 1440');

 await page.locator('[data-attention=check_in]').getByRole('button',{name:'Answer'}).click();
 let dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'Is PAY-31 on track?'}).waitFor();
 await dialog.getByRole('radio',{name:/Need more time/}).click();
 await dialog.getByLabel('New date').fill('2030-01-10');await dialog.getByLabel('Note').fill('The bank sandbox is down until Thursday.');
 await shot(page,'checkin-1440.png');
 await dialog.getByRole('button',{name:'Send'}).click();await dialog.waitFor({state:'detached'});
 assert.deepEqual(writes.at(-1).b,{answer:'more_time',note:'The bank sandbox is down until Thursday.',newDate:'2030-01-10'});checks.push('check-in');

 await page.locator('[data-attention=double_booked]').getByRole('button',{name:'Send the agent'}).click();
 dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'Send the agent in my place'}).waitFor();
 await dialog.getByLabel('What should it raise').fill('Ask whether refunds can ship on Friday.');
 await shot(page,'delegate-1440.png');
 await dialog.getByRole('button',{name:'Send the agent'}).click();await dialog.waitFor({state:'detached'});
 assert.equal(writes.at(-1).ep,'/api/v1/agent/delegations');assert.equal(writes.at(-1).b.meetingId,'m1');assert.equal(writes.at(-1).b.instructions,'Ask whether refunds can ship on Friday.');checks.push('delegate');

 await page.getByRole('button',{name:/What if/}).click();
 dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'What if a task slips?'}).waitFor();
 await dialog.getByLabel('Task').selectOption('t12');
 await dialog.locator('.cmd-gantt-row').nth(2).waitFor();
 assert.ok(await dialog.getByText('UAT sign-off (due 19 Jan) would be missed by 1 day').isVisible());
 assert.equal(writes.at(-1).b.taskId,'t12');checks.push('what-if');
 await shot(page,'what-if-1440.png');
 await dialog.getByRole('button',{name:'Done'}).click();

 // Meetings are in Meet now (no Meetings tab on Home); "My agent" for meetings sits with the notetaker there.
 assert.equal(await page.locator('.cmd-tabs').getByRole('button',{name:'Meetings'}).count(),0,'No Meetings tab on Home');
 await page.goto(origin+'/preview-org/meet/notetaker');
 await page.getByRole('switch',{name:'Go when I am double-booked'}).click();await page.waitForTimeout(300);
 assert.deepEqual(writes.at(-1).b,{autoDelegate:true});checks.push('auto-delegate-setting');
 await shot(page,'meet-notetaker-1440.png',true);
 // Today's "Coming up" still opens the brief.
 await page.goto(origin+'/preview-org/command-center?tab=today');await page.locator('[data-attention]').first().waitFor();
 await page.locator('.cmd-timeline').getByRole('button',{name:'Brief'}).first().click();
 dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'Brief: Payments stand-up'}).waitFor();
 assert.ok(await dialog.getByText('Unblock PAY-9').isVisible());checks.push('brief');
 await shot(page,'brief-1440.png');
 await page.keyboard.press('Escape');

 await page.locator('.cmd-tabs button',{hasText:'My work'}).click();await page.locator('.cmd-mywork').waitFor();await page.waitForTimeout(300);
 assert.ok(new URL(page.url()).searchParams.get('tab')==='work');checks.push('my-work-tab');
 await page.goto(origin+'/preview-org/my-work');await page.waitForURL(/command-center\?tab=work/);await page.locator('.cmd-mywork').waitFor();checks.push('my-work-redirect');
 await page.getByRole('button',{name:'Decisions'}).click();await page.getByRole('heading',{name:'Launch in two phases'}).waitFor();
 await shot(page,'decisions-1440.png');checks.push('decisions');
 await page.getByRole('button',{name:'Audit trail'}).click();await page.getByText('Carried out by the agent',{exact:true}).waitFor();
 assert.ok(await page.getByText('due 2030-01-15 · In progress · Upendra Rao · High').isVisible());
 await shot(page,'audit-1440.png');checks.push('audit');
 await noOverflow(page,'audit 1440');

 // The project's Agent tab: autonomy levels.
 await page.goto(origin+`/preview-org/projects/${pid}?tab=agent`);
 await page.getByRole('radiogroup',{name:'Autonomy level'}).waitFor();
 assert.ok(await page.getByRole('button',{name:'New tasks'}).isVisible());
 await page.getByRole('button',{name:'New tasks'}).click();await page.waitForTimeout(300);
 assert.deepEqual(writes.at(-1).b,{enabled:true,autoApplyKinds:['CreateActionItem','Decision','Suggestion','Missed','CreateTask']});
 await page.getByRole('radio',{name:/Participant/}).click();await page.waitForTimeout(300);
 assert.deepEqual(writes.at(-1).b,{enabled:true,autonomyLevel:3});checks.push('autonomy');
 await page.locator('.ag-levels').scrollIntoViewIfNeeded();await shot(page,'autonomy-1440.png');
 await page.close();await ctx.close();

 // Phone, light and dark: the same screens fit, the actions are full width, nothing scrolls sideways.
 for(const theme of ['light','dark']){
  ctx=await make(theme);
  page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/preview-org/command-center?tab=today');await page.locator('[data-attention]').first().waitFor();
  await shot(page,`command-390-${theme}.png`,true);await noOverflow(page,`command 390 ${theme}`);
  if(theme==='light'){
   assert.ok(await page.locator('.m-tabs').getByRole('link',{name:'Home'}).isVisible(),'Home (the Command Center) is a phone tab');checks.push('phone-tab');
   await page.locator('[data-attention=check_in]').getByRole('button',{name:'Answer'}).click();
   dialog=page.getByRole('dialog');await dialog.getByRole('radio',{name:/On track/}).waitFor();
   await shot(page,'checkin-390.png');await noOverflow(page,'check-in 390');
   await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
   await page.goto(origin+'/preview-org/meet');await page.getByRole('button',{name:'Schedule',exact:true}).waitFor();
   await shot(page,'meet-390.png',true);await noOverflow(page,'meet 390');
   await page.goto(origin+'/preview-org/command-center?tab=today');await page.locator('[data-attention]').first().waitFor();
   await page.getByRole('button',{name:/What if/}).click();
   dialog=page.getByRole('dialog');await dialog.getByLabel('Task').selectOption('t12');await dialog.locator('.cmd-gantt-row').nth(2).waitFor();
   await shot(page,'what-if-390.png');await noOverflow(page,'what-if 390');
  }
  checks.push(`phone-${theme}`);
  await page.close();await ctx.close();
 }

 // A new task suggests who, how long, when and how urgent from similar finished work; "Use all" fills only empty fields.
 ctx=await make('light');page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+`/preview-org/projects/${pid}`);await page.getByRole('button',{name:'Add task'}).first().click();
 const tm=page.getByRole('dialog');await tm.getByPlaceholder('e.g. Complete API development').fill('CRIF HIGHMARK API integration');
 await tm.locator('.tsg-chip').first().waitFor();assert.equal(await tm.locator('.tsg-chip').count(),4);
 await page.waitForTimeout(400);await page.screenshot({path:path.join(out,'task-suggestions-1440.png'),animations:'disabled'});
 await tm.getByRole('button',{name:'Use all'}).click();await page.waitForTimeout(200);
 assert.equal(await tm.locator('input[type=number]').first().inputValue(),'7');assert.equal(await tm.locator('input[type=date]').last().inputValue(),'2030-01-17');
 assert.equal(await tm.locator('.tsg-chip').count(),0,'every suggestion was used');checks.push('task-suggestions');
 // Quick add: one line of plain words, what was understood shown as chips, one dismissed, Enter adds.
 await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'}).catch(()=>{});
 const qa=page.getByLabel('Add a task in plain words');await qa.waitFor();await qa.fill('fix login bug for me by tomorrow, high, 3h');
 await page.locator('.qa-chip').nth(3).waitFor();assert.equal(await page.locator('.qa-chip').count(),4);assert.equal((await page.locator('.qa-title').innerText()).trim(),'Fix login bug');
 await page.waitForTimeout(200);await page.screenshot({path:path.join(out,'quick-add-1440.png'),animations:'disabled'});
 await page.getByRole('button',{name:/Not the estimate/}).click();assert.equal((await page.locator('.qa-title').innerText()).trim(),'Fix login bug, 3h');
 await qa.press('Enter');for(let i=0;i<20&&!writes.some(w=>w.ep===`/api/v1/projects/${pid}/tasks`);i++)await page.waitForTimeout(100);
 const made=writes.find(w=>w.ep===`/api/v1/projects/${pid}/tasks`).b;assert.equal(made.title,'Fix login bug, 3h');assert.equal(made.priority,'High');assert.equal(made.assigneeId,user.id);assert.equal(made.estimatedHours,null);
 assert.match(made.dueDate,/^\d{4}-\d{2}-\d{2}$/);for(let i=0;i<30&&await qa.inputValue()!=='';i++)await page.waitForTimeout(100);assert.equal(await qa.inputValue(),'','the box empties after adding');checks.push('quick-add');
 await page.close();await ctx.close();
 // AI-first Home: Home becomes the assistant (ask box, conversations, four rule tiles); the sidebar's Assistant becomes Agents; Classic view returns.
 ctx=await make('light',null);page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/command-center');// AI-first is the default: no switch to press.
 await page.locator('.aih-hero h1').waitFor();assert.match(await page.locator('.aih-hero h1').innerText(),/Good (morning|afternoon|evening)/);
 await page.locator('.aih-tile').nth(3).waitFor();assert.equal(await page.locator('.aih-tile').count(),4);
 assert.ok(await page.locator('.aih-hero .ai-composer.stacked').isVisible(),'the ask box sits in the middle of Home');
 assert.equal(await page.locator('.ai-rail').count(),0,'no conversation list beside the chat');
 assert.ok(await page.locator('.ai-box-bar .ai-attach').isVisible(),'attach is inside the ask box');
 await page.locator('.aih-recent button',{hasText:'CRIF HIGHMARK'}).waitFor();
 for(const chip of ['What needs me','Catch me up','Plan my day','Submit my week'])assert.ok(await page.locator('.aih-chips button',{hasText:chip}).isVisible(),chip);
 await page.locator('.ai-mode-menu > summary[aria-label="Thinking level: Auto"]').click();await page.waitForTimeout(250);await page.screenshot({path:path.join(out,'ai-first-home-level-1440.png'),animations:'disabled'});await page.getByRole('menuitemradio',{name:/Quick/}).click();
 await page.locator('.ai-mode-menu > summary[aria-label="Thinking level: Quick"]').waitFor();
 await page.locator('.aih-history > summary').click();await page.locator('.aih-history-panel input[aria-label="Search conversations"]').waitFor();await page.waitForTimeout(250);await page.screenshot({path:path.join(out,'ai-first-home-chats-1440.png'),animations:'disabled'});
 await page.locator('.aih-history-panel input[aria-label="Search conversations"]').fill('zzz');await page.locator('.aih-history-panel',{hasText:'Nothing matches.'}).waitFor();
 await page.keyboard.press('Escape');assert.ok(!(await page.locator('.aih-history-panel').isVisible()),'Escape closes the Chats menu');
 await page.locator('.aih-recent button',{hasText:'CRIF HIGHMARK'}).click();await page.locator('.ai-thread .ai-msg').nth(1).waitFor();assert.match(page.url(),/[?&]c=c1/,'the chat stays on Home');
 assert.ok(await page.locator('.ai-main > .ai-composer.stacked').isVisible(),'the ask box moves to the bottom in a chat');
 // A request with several parts keeps its plan: a step follows the card it prepared (confirmed = done, waiting = waiting for you).
 const steps=page.getByTestId('ai-plan');await steps.waitFor();
 assert.equal(await steps.locator('li').count(),3);
 assert.match(await steps.locator('header').innerText(),/2 of 3 done/);
 assert.ok(await steps.locator('li').nth(0).evaluate(e=>e.classList.contains('st-done')),'the confirmed card makes its step done');
 assert.ok(await steps.locator('li').nth(1).evaluate(e=>e.classList.contains('st-waiting')));
 assert.match(await steps.locator('li').nth(1).innerText(),/Waiting for you/);
 assert.equal(await page.locator('.ai-tools .ai-tool',{hasText:'Planned the steps'}).count(),0,'the plan is not also a chip');
 await steps.scrollIntoViewIfNeeded();await page.waitForTimeout(200);await page.screenshot({path:path.join(out,'ai-plan-1440.png'),animations:'disabled'});
 checks.push('plan-steps');await page.locator('.aih-bar-title b',{hasText:'CRIF HIGHMARK'}).waitFor();
 await page.waitForTimeout(250);await page.screenshot({path:path.join(out,'ai-first-home-chat-1440.png'),animations:'disabled'});
 await page.getByRole('button',{name:'New chat'}).click();await page.locator('.aih-hero h1').waitFor();
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);await page.screenshot({path:path.join(out,'ai-first-home-phone.png'),animations:'disabled'});await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('link',{name:'Agents'}).first().waitFor();assert.equal(await page.getByRole('link',{name:'Assistant',exact:true}).count(),0,'no separate Assistant entry');
 await page.waitForTimeout(300);await page.screenshot({path:path.join(out,'ai-first-home-1440.png'),animations:'disabled'});
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));await page.waitForTimeout(150);await page.screenshot({path:path.join(out,'ai-first-home-dark-1440.png'),fullPage:true,animations:'disabled'});
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
 await page.setViewportSize({width:820,height:1000});await page.waitForTimeout(200);await page.screenshot({path:path.join(out,'ai-first-home-820.png'),fullPage:true,animations:'disabled'});
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/ai');await page.locator('.aih-hero').waitFor();assert.ok(!new URL(page.url()).pathname.endsWith('/ai'),'the Assistant page leads to Home');
 await page.reload();await page.locator('.aih-hero').waitFor();
 // There is no classic Home any more: the full views open from Home, with a Home tab back.
 assert.equal(await page.getByRole('button',{name:'Classic view'}).count(),0,'no classic view');
 await page.getByRole('button',{name:'Dashboard'}).click();await page.locator('.cmd-tabs').waitFor();assert.match(page.url(),/[?&]tab=dashboard/);
 await page.locator('.cmd-tabs .cmd-home-tab').click();await page.locator('.aih-hero').waitFor();assert.ok(!/[?&]tab=/.test(page.url()));
 checks.push('ai-first-home');await page.close();await ctx.close();
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,writes:writes.length,errors,scope:'Built frontend with synthetic fixtures; no live meetings, mail or AI.'},null,2));
 console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
