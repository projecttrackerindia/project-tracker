import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// The project agent screens against the built frontend and synthetic API fixtures only. No live project, mail, meeting or AI calls.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/agent-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Alex Morgan',email:'agent@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ravi={userId:'00000000-0000-0000-0000-000000000009',displayName:'Ravi Kumar',email:'ravi@example.test',role:'Member'};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:2};
const pid='00000000-0000-0000-0000-000000000003';
const project={id:pid,key:'PAY',name:'Payments Core',description:'Payment gateway and settlement.',status:'Active',priority:'High',health:'OnTrack',progress:40,active:2,startDate:'2030-01-01',dueDate:'2030-03-01',version:3,stageScheduleMode:'Manual',projectType:'NewProject',deliveryMethod:'Agile',owner:{id:user.id,name:user.displayName},stats:{total:6,done:2,inProgress:2,cancelled:0,todo:2,overdue:1}};
const detail={project,stages:[],statuses:[{id:pid,name:'To Do',order:0,category:'Todo',color:'#4f46e5'}],members:[{userId:user.id,name:user.displayName,email:user.email,role:'Owner'}]};
const finding=(id,kind,title,extra={})=>({id,projectId:pid,projectKey:'PAY',projectName:'Payments Core',runId:'run-1',kind,status:'Proposed',title,detail:null,evidence:null,sourceLabel:'Stand-up · 18 Oct',source:'MeetingTranscript',
  taskId:null,taskKey:null,taskTitle:null,issueId:null,issueKey:null,assignee:null,dueDate:null,priority:null,newStatus:null,comment:null,confidence:82,createdAt:'2030-01-06T05:00:00Z',decidedBy:null,decidedAt:null,appliedEntityId:null,appliedKey:null,error:null,
  grounded:true,edits:null,ownerResponse:null,ownerNote:null,ownerRespondedAt:null,...extra});
let findings=[
  finding('f1','CreateTask','Prepare the go-live checklist',{detail:'The client asked for the checklist before UAT sign-off.',evidence:'can you send the go-live checklist by Friday?',assignee:{id:ravi.userId,name:ravi.displayName},dueDate:'2030-01-10',priority:'High',source:'ProjectMailbox',sourceLabel:'Email from client@bank.example · 06 Jan'}),
  finding('f2','UpdateTask','Gateway integration is in progress',{evidence:'I started the gateway integration, sandbox keys are in',taskId:'t-12',taskKey:'PAY-12',taskTitle:'Payment gateway integration',newStatus:'in_progress',comment:'Integration started; sandbox keys received.'}),
  finding('f3','Delay','Settlement report will slip by a week',{detail:'Waiting on the bank\'s file format.',evidence:'we still do not have the settlement file spec',taskId:'t-9',taskKey:'PAY-9',taskTitle:'Settlement report',dueDate:'2030-01-17'}),
  finding('f4','Missed','Nobody owns the refund flow',{detail:'Raised twice in the call, no owner or date.',evidence:'who is doing refunds?',confidence:34,grounded:false}),
  finding('f5','Suggestion','Add a retry queue for failed payments',{evidence:'we should retry failed payments automatically',source:'Chat',sourceLabel:'Project chat · 06 Jan',confidence:66}),
];
let agent={projectId:pid,enabled:false,readMailbox:true,readChat:true,readMeetings:true,liveBot:false,dailyUpdates:true,mailboxAddress:'agent+0a1b2c3d4e5f60718293a4b5@inbound.projecttracker.in',liveBotAvailable:true,aiAvailable:true,monthlyCreditCap:120,creditsThisMonth:96,
  pending:0,lastRunAt:null,lastError:null,runsThisMonth:0,monthlyRunLimit:300,canManage:true,actingUserName:'Alex Morgan',runs:[],transcriptAccess:false,
  instructions:null,speakerAliases:null,autoTranscriptAccess:false,captionLanguage:null,autoJoinCalendar:false,sendMinutes:true,slackChannelId:null,slackAvailable:true,readWhatsApp:true,whatsAppAvailable:true};
let given=[finding('g1','CreateTask','Send the go-live checklist',{status:'Applied',assignee:{id:user.id,name:user.displayName},appliedKey:'PAY-31',appliedEntityId:'t-31',
  evidence:'can you send the go-live checklist by Friday?',decidedBy:{id:ravi.userId,name:ravi.displayName},decidedAt:'2030-01-06T06:00:00Z'})];
let workspace={botAvailable:true,botName:'Project Tracker Agent',inCallReminders:true,canManage:true,enabledProjects:1};
let optIn={googleAvailable:true,microsoftAvailable:false,provider:null,enabled:false,scannedUntil:null,found:0,lastError:null};
let autonomy={projectId:pid,level:2,minDecisions:30,minRate:95,
 kinds:[{kind:'CreateActionItem',decided:41,approved:40,approvedAsIs:40,edited:0,dismissed:1,rate:97,safe:true,automatic:false,suggested:true,reasons:[{reason:'duplicate',label:'already proposed or exists',count:1}]},
  {kind:'UpdateTask',decided:22,approved:15,approvedAsIs:11,edited:4,dismissed:7,rate:50,safe:false,automatic:false,suggested:false,reasons:[{reason:'wrong',label:'the agent got it wrong',count:4},{reason:'unspecified',label:'no reason given',count:3}]}],
 hints:[{projectId:pid,projectKey:'PAY',projectName:'Payments Core',kind:'CreateActionItem',decided:41,rate:97,level:2,message:"The team approved 97% of the agent's action items unchanged (41 decisions in 90 days). Let it create them by itself? The project goes to level 4 (Delegate) for this kind only."}]};
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  const body=()=>{try{return req.postDataJSON();}catch{return null;}};
  if(ep===`/api/v1/projects/${pid}/agent`&&method==='PUT'){const b=body();writes.push({ep,b});agent={...agent,...b};if(b.enabled&&agent.runs.length===0){agent.runs=[{id:'run-1',trigger:'meeting',meeting:true,minutesSentAt:null,status:'done',signalCount:3,findingCount:5,credits:4,summary:'The gateway work is moving; the client wants the go-live checklist and nobody owns refunds yet.',error:null,startedAt:'2030-01-06T05:00:00Z',finishedAt:'2030-01-06T05:00:20Z'}];agent.lastRunAt='2030-01-06T05:00:20Z';}data=agent;}
  else if(ep===`/api/v1/projects/${pid}/agent`){data={...agent,pending:agent.enabled?findings.filter(f=>f.status==='Proposed').length:0};}
  else if(ep===`/api/v1/projects/${pid}/agent/findings`){const s=url.searchParams.get('status')||'proposed';const items=agent.enabled?findings.filter(f=>s==='all'||f.status.toLowerCase()===(s==='applied'?'applied':s)):[];data={items,pending:findings.filter(f=>f.status==='Proposed').length,canDecide:true};}
  else if(ep===`/api/v1/projects/${pid}/agent/autonomy`)data=autonomy;
  else if(ep===`/api/v1/projects/${pid}/agent/autonomy/CreateActionItem/accept`&&method==='POST'){writes.push({ep,b:null});agent={...agent,autonomyLevel:4,autoApplyKinds:['CreateActionItem']};autonomy={...autonomy,level:4,hints:[],kinds:autonomy.kinds.map(k=>k.kind==='CreateActionItem'?{...k,automatic:true,suggested:false}:k)};data=autonomy;}
  else if(ep===`/api/v1/projects/${pid}/agent/join-link`&&method==='POST'){const b=body();writes.push({ep,b});data={id:'bot-1',platform:'Microsoft Teams',title:b.title??'Microsoft Teams call',startUtc:'2030-01-06T08:00:00Z',endUtc:'2030-01-06T09:00:00Z',status:'scheduled'};}
  else if(ep===`/api/v1/projects/${pid}/agent/runs/run-1/minutes`&&method==='POST'){writes.push({ep,b:null});agent.runs[0].minutesSentAt='2030-01-06T08:00:00Z';data={sent:3};}
  else if(ep==='/api/v1/agent/assigned')data={items:given,pending:given.filter(g=>!g.ownerResponse).length,canDecide:false};
  else if(ep.startsWith('/api/v1/agent/findings/')&&ep.endsWith('/respond')&&method==='POST'){const b=body();writes.push({ep,b});const g=given.find(x=>x.id===ep.split('/')[5]);assert.ok(g,'known given item');Object.assign(g,{ownerResponse:b.response,ownerNote:b.note??null});data=g;}
  else if(ep.startsWith('/api/v1/agent/findings/')&&method==='POST'){
   const id=ep.split('/')[5],act=ep.split('/')[6],b=body();writes.push({ep,b});
   const f=findings.find(x=>x.id===id);assert.ok(f,'known finding');
   if(act==='approve'){Object.assign(f,{status:'Applied',decidedBy:{id:user.id,name:user.displayName},decidedAt:'2030-01-06T06:00:00Z',appliedKey:f.kind==='CreateTask'?'PAY-31':f.taskKey,title:b?.title??f.title});}
   else{Object.assign(f,{status:'Dismissed',dismissReason:b?.reason??null,decidedBy:{id:user.id,name:user.displayName},decidedAt:'2030-01-06T06:00:00Z'});}
   data=f;
  }
  else if(ep===`/api/v1/projects/${pid}/agent/transcript`&&method==='POST'){const b=body();writes.push({ep,b});data={signalId:'s-9',run:{id:'run-2',trigger:'manual',status:'done',signalCount:1,findingCount:2,credits:4,summary:null,error:null,startedAt:'2030-01-06T07:00:00Z',finishedAt:'2030-01-06T07:00:10Z'}};}
  else if(ep==='/api/v1/agent/inbox'){const items=findings.filter(f=>f.status==='Proposed');data={items,pending:items.length,canDecide:true};}
  else if(ep==='/api/v1/agent/my-inbox'&&method==='PUT'){const b=body();writes.push({ep,b});optIn={...optIn,provider:b.provider??optIn.provider,enabled:b.enabled,scannedUntil:'2030-01-06T05:30:00Z'};data=optIn;}
  else if(ep==='/api/v1/agent/my-inbox')data=optIn;
  else if(ep==='/api/v1/agent/workspace'&&method==='PUT'){const b=body();writes.push({ep,b});workspace={...workspace,botName:b.botName??workspace.botName,inCallReminders:b.inCallReminders??workspace.inCallReminders};data=workspace;}
  else if(ep==='/api/v1/agent/workspace')data=workspace;
  else{
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:'synthetic-token',expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','tasks.view','tasks.edit','tasks.create','org.manage','work.view','reports.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep===`/api/v1/projects/${pid}`)data=detail;
   else if(ep.endsWith('/workspace/members'))data=[{userId:user.id,displayName:user.displayName,email:user.email,role:'Owner'},ravi];
   else if(ep===`/api/v1/projects/${pid}/meetings`)data=[];
   else if(ep==='/api/v1/projects')data={items:[project],page:1,totalPages:1,totalItems:1};
   else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep==='/api/v1/chat/projects/unread')data=[];
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 const noOverflow=async(page,what)=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${what}: no sideways scroll`);

 // Desktop: switch the agent on, review, approve, edit and approve, dismiss, add a transcript.
 let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1100});
 await page.goto(origin+`/preview-org/projects/${pid}?tab=agent`);
 await page.getByRole('heading',{name:'Let an agent keep this project up to date'}).waitFor();
 await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,'agent-off-1440.png'),animations:'disabled'});
 await page.getByRole('button',{name:/Switch on the agent/}).click();
 await page.getByRole('heading',{name:'Prepare the go-live checklist'}).waitFor();
 assert.equal(writes.at(-1).b.enabled,true);checks.push('switch-on');
 assert.ok(await page.getByText('agent+0a1b2c3d4e5f60718293a4b5@inbound.projecttracker.in').isVisible());
 assert.ok(await page.getByText('“who is doing refunds?”').isVisible());
 assert.ok(await page.locator('[data-finding=f4]').getByText('Check the source').isVisible());assert.equal(await page.locator('[data-finding=f1]').getByText('Check the source').count(),0);checks.push('ungrounded-flag');
 await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,'agent-queue-1440.png'),animations:'disabled',fullPage:true});
 await noOverflow(page,'queue 1440');

 let card=page.locator('[data-finding=f1]');
 await card.getByRole('button',{name:'Create task'}).click();await card.getByText('Done as').waitFor({timeout:5000}).catch(()=>{});
 assert.ok(writes.some(w=>w.ep.endsWith('/f1/approve')));checks.push('approve');

 card=page.locator('[data-finding=f2]');
 await card.getByRole('button',{name:'Edit'}).click();
 await card.getByLabel('Title',{exact:true}).fill('Gateway integration started');
 await card.getByLabel('Status',{exact:true}).selectOption('done');
 await page.screenshot({path:path.join(out,'agent-edit-1440.png'),animations:'disabled'});
 await card.getByRole('button',{name:'Apply update'}).click();
 await page.waitForTimeout(300);
 const edit=writes.find(w=>w.ep.endsWith('/f2/approve'));assert.equal(edit.b.title,'Gateway integration started');assert.equal(edit.b.newStatus,'done');checks.push('edit-and-approve');

 card=page.locator('[data-finding=f5]');
 await card.getByRole('button',{name:'Dismiss'}).click();await card.getByRole('group',{name:'Why dismiss it'}).waitFor();
 await page.screenshot({path:path.join(out,'agent-dismiss-why-1440.png'),animations:'disabled'});
 await card.getByRole('button',{name:'Duplicate'}).click();await page.waitForTimeout(300);
 assert.deepEqual(writes.find(w=>w.ep.endsWith('/f5/dismiss')).b,{reason:'duplicate'});checks.push('dismiss-with-reason');

 // Credits: the month's use against the cap, and changing the cap.
 assert.ok(await page.getByRole('meter',{name:'Credits used of the monthly cap'}).isVisible());
 await page.getByRole('button',{name:'Change cap'}).click();await page.getByLabel('Monthly credit cap').fill('200');
 await page.locator('.ag-credits-form').getByRole('button',{name:'Save'}).click();await page.waitForTimeout(300);
 assert.deepEqual(writes.at(-1).b,{enabled:true,monthlyCreditCap:200});checks.push('credit-cap');

 // Earned autonomy: how the team decides, and "let it" for the kind it has earned.
 const trust=page.locator('.ag-trust');await trust.getByText('How the team decides').waitFor();
 assert.ok(await trust.getByText(/approved 97% of the agent's action items/).isVisible());
 await trust.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'agent-trust-1440.png'),animations:'disabled'});
 await trust.getByRole('button',{name:'Yes, let it'}).click();await page.waitForTimeout(300);
 assert.ok(writes.at(-1).ep.endsWith('/autonomy/CreateActionItem/accept'));await trust.locator('.ag-earned').waitFor({state:'detached'});checks.push('earned-autonomy');

 // Send the bot to a Teams call by its link.
 await page.getByRole('button',{name:'Send to a call'}).click();
 const call=page.getByRole('dialog');await call.getByRole('heading',{name:'Send the agent to a call'}).waitFor();
 await call.getByLabel('Meeting link').fill('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0');
 await call.getByText('Microsoft Teams - someone in the call lets the agent in').waitFor();
 await call.getByLabel('Name',{exact:true}).fill('Customer sync');
 await page.screenshot({path:path.join(out,'agent-join-call-1440.png'),animations:'disabled'});
 await call.getByRole('button',{name:'Send it now'}).click();await call.waitFor({state:'detached'});
 assert.deepEqual(writes.at(-1).b,{url:'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0',title:'Customer sync',minutes:60});checks.push('join-teams-link');

 await page.getByRole('button',{name:'Add transcript'}).click();
 const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'Add a transcript'}).waitFor();
 await dialog.getByLabel('Title',{exact:true}).fill('Stand-up 06 Jan');
 await dialog.locator('textarea').fill('Ravi: I finished the gateway sandbox.\nPriya: Refund screens break on small phones; I will log tickets.');
 await page.screenshot({path:path.join(out,'agent-transcript-1440.png'),animations:'disabled'});
 await dialog.getByRole('button',{name:'Read it'}).click();await dialog.waitFor({state:'detached'});
 const t=writes.find(w=>w.ep.endsWith('/agent/transcript'));assert.equal(t.b.title,'Stand-up 06 Jan');assert.match(t.b.text,/Refund screens/);checks.push('transcript');

 // The source switches save the whole setting.
 await page.getByRole('switch',{name:'Live meeting bot'}).click();await page.waitForTimeout(300);
 assert.equal(writes.at(-1).b.liveBot,true);assert.equal(writes.at(-1).b.enabled,true);checks.push('source-switch');
 await page.getByRole('switch',{name:'Calls on my calendar'}).click();await page.waitForTimeout(300);
 assert.deepEqual(writes.at(-1).b,{enabled:true,autoJoinCalendar:true});checks.push('calendar-switch');

 // Notes, names, the meeting language and the Slack channel.
 await page.getByRole('button',{name:'Notes and names'}).click();
 const tune=page.getByRole('dialog');await tune.getByRole('heading',{name:'Notes and names'}).waitFor();
 await tune.getByLabel('Notes for the agent').fill('UAT means the bank test environment.');
 await tune.getByLabel('Names in calls and chat').fill('RK = ravi@example.test');
 await tune.getByLabel('Meeting language').selectOption('hi');
 await tune.getByLabel('Slack channel ID').fill('C0PAYMENTS1');
 await page.screenshot({path:path.join(out,'agent-tune-1440.png'),animations:'disabled'});
 await tune.getByRole('button',{name:'Save',exact:true}).click();await tune.waitFor({state:'detached'});
 assert.deepEqual(writes.at(-1).b,{enabled:true,instructions:'UAT means the bank test environment.',speakerAliases:'RK = ravi@example.test',captionLanguage:'hi',slackChannelId:'C0PAYMENTS1'});
 await page.getByText('Hindi',{exact:true}).waitFor();checks.push('notes-and-names');

 // The MOM (minutes with the transcript) is e-mailed from a meeting reading.
 assert.ok(await page.getByRole('button',{name:'Use my Google account'}).isVisible());
 await page.getByRole('button',{name:'E-mail MOM'}).click();
 const mom=page.getByRole('dialog');await mom.getByRole('button',{name:'Send',exact:true}).click();await mom.waitFor({state:'detached'});
 assert.ok(writes.at(-1).ep.endsWith('/agent/runs/run-1/minutes'));await page.getByText('Minutes e-mailed to 3 people.').waitFor();checks.push('email-mom');
 await page.close();

 // Phone width: the same tab fits.
 page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:900});
 await page.goto(origin+`/preview-org/projects/${pid}?tab=agent`);await page.locator('.ag-card').first().waitFor();
 await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,'agent-queue-390.png'),animations:'disabled',fullPage:true});
 await noOverflow(page,'queue 390');checks.push('phone');
 await page.close();

 // The Project agent page: review across projects, my inbox, meeting bot.
 page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/project-agent');await page.locator('.agh').getByText('Assistant',{exact:true}).waitFor();
 await page.locator('.ag-card').first().waitFor();assert.ok(await page.getByRole('link',{name:'PAY · Payments Core'}).first().isVisible());
 await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,'agent-page-review.png'),animations:'disabled'});checks.push('agent-page');
 await page.getByRole('link',{name:/Given to me/}).click();
 const g=page.locator('[data-given=g1]');await g.getByRole('button',{name:'Not mine'}).click();
 await g.getByLabel('Whose is it, or why not you').fill('Priya owns go-live');
 await page.screenshot({path:path.join(out,'agent-page-given.png'),animations:'disabled'});
 await g.getByRole('button',{name:'Send'}).click();await g.getByText('You said it is not yours: Priya owns go-live.').waitFor();
 assert.deepEqual(writes.at(-1).b,{response:'declined',note:'Priya owns go-live'});checks.push('not-mine');
 await page.getByRole('link',{name:'My inbox'}).click();await page.getByRole('switch',{name:'Use Gmail'}).click();await page.waitForTimeout(300);
 assert.deepEqual(writes.at(-1).b,{provider:'google',enabled:true});
 await page.screenshot({path:path.join(out,'agent-page-inbox.png'),animations:'disabled'});checks.push('inbox-opt-in');
 await page.getByRole('link',{name:'Meeting bot'}).click();await page.getByText(/Ready ·/).waitFor();
 await page.getByLabel('Bot name').fill('Tracker Bot');
 await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForTimeout(300);
 assert.deepEqual(writes.at(-1).b,{botName:'Tracker Bot'});
 await page.screenshot({path:path.join(out,'agent-page-bot.png'),animations:'disabled'});checks.push('meeting-bot');
 await noOverflow(page,'agent page');
 await page.close();

 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,writes:writes.length,errors,scope:'Built frontend with synthetic fixtures; no live mail, meetings or AI.'},null,2));
 console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
