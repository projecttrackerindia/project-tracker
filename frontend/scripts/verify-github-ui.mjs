import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// The GitHub App: install completes from GitHub's redirect, status rules and risky folders save, a task shows its pull request's checks,
// review and risk and starts a branch, Home shows the review queue, and the project's Code tab shows delivery and release notes.
// Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/github-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false,mfaEnabled:true};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const pid='00000000-0000-0000-0000-000000000003', tid='00000000-0000-0000-0000-000000000004';
const project={id:pid,key:'PAY',name:'Refunds',description:'Refund flows.',status:'Active',priority:'Medium',health:'OnTrack',progress:40,active:1,startDate:'2026-10-01',dueDate:'2026-12-01',version:2,stageScheduleMode:'FollowSchedule',projectType:'NewProject',deliveryMethod:'Hybrid',owner:{id:user.id,name:user.displayName},stats:{total:1,done:0,inProgress:1,cancelled:0,todo:0,overdue:0}};
const statuses=[{id:'st1',name:'Yet To Start',order:0,category:'Todo',color:'#38bdf8'},{id:'st2',name:'Review',order:1,category:'Active',color:'#fbbf24'},{id:'st3',name:'Done',order:2,category:'Done',color:'#34d399'}];
const detail={project,stages:[],statuses,members:[{userId:user.id,name:user.displayName,email:user.email,role:'Owner'}]};
const task={id:tid,projectId:pid,projectKey:'PAY',projectName:'Refunds',number:12,key:'PAY-12',title:'Fix refund rounding',description:null,statusId:'st2',statusName:'Review',statusCategory:'Active',statusColor:'#fbbf24',priority:'High',
 assignee:{id:user.id,name:user.displayName},reporter:{id:user.id,name:user.displayName},startDate:null,dueDate:null,estimatedHours:null,actualHours:null,position:1,parentTaskId:null,subtaskTotal:0,subtaskDone:0,commentCount:0,labels:[],
 completedAt:null,createdAt:iso(-60*24),updatedAt:iso(-60),version:3,isOverdue:false,milestoneId:null,milestoneName:null,dependsOnCount:0,blocksCount:0,isBlocked:false,sprintId:null,sprintName:null,checklistTotal:0,checklistDone:0,canEdit:true,stageId:null,stageName:null};
let app={configured:true,installed:false,account:null,accountType:null,selection:null,repositories:[],rules:{opened:'In Review',approved:'Ready',merged:'Done',reopenOnRevert:true},riskyPaths:[],closeOnKeyword:true,received:0,lastEventAt:null,lastError:null,manageUrl:null,suspended:false};
let links=[
 {id:'l1',provider:'GitHub',kind:'pull_request',externalId:'42',title:'PAY-12 Fix refund rounding',url:'https://github.test/acme/payments/pull/42',repository:'acme/payments',author:'ravi',state:'open',occurredAt:iso(-90),
  branch:'PAY-12-fix-refund-rounding',checksState:'success',reviewState:null,draft:false,additions:1200,deletions:30,changedFiles:1,riskScore:80,riskReasons:['1,230 lines changed','Code changed with no test changed','First change to src/payments by ravi'],mergedAt:null,awaitingReview:true},
 {id:'l2',provider:'GitHub',kind:'commit',externalId:'abc1234def',title:'Round half-even',url:'https://github.test/acme/payments/commit/abc1234',repository:'acme/payments',author:'ravi',state:null,occurredAt:iso(-120)},
];
const queue={waitingOnMe:1,oldestDays:3,gitHubLinked:true,items:[
 {linkId:'l1',repository:'acme/payments',number:'42',title:'PAY-12 Fix refund rounding',url:'https://github.test/acme/payments/pull/42',author:'ravi',waitingSince:iso(-60*24*3),days:3,taskKey:'PAY-12',checksState:'failure',riskScore:80,role:'reviewer'},
 {linkId:'l9',repository:'acme/web',number:'7',title:'Portal login copy',url:'https://github.test/acme/web/pull/7',author:'asha',waitingSince:iso(-60*5),days:0,taskKey:null,checksState:'success',riskScore:10,role:'author'}]};
const delivery={days:90,leadTimeHours:30.5,leadTimeBasis:'first commit to production',deploysPerWeek:2.3,changeFailureRate:0.125,restoreHours:3.2,notes:[],repositories:['acme/payments'],
 weeks:Array.from({length:13},(_,i)=>({weekStart:new Date(now-(12-i)*7*86400000).toISOString().slice(0,10),deploys:i%3,failed:i===5?1:0,leadTimeHours:i%2?24:null,merged:(i%4)+1}))};
const notes={from:'2026-10-09',to:'2026-10-23',unlinked:[],markdown:'# Refunds: release notes\n\n- **PAY-12** Fix refund rounding\n',tasks:[{key:'PAY-12',title:'Fix refund rounding',pullRequests:[{repository:'acme/payments',number:'42',title:'PAY-12 Fix refund rounding',url:'https://github.test/acme/payments/pull/42',author:'ravi',mergedAt:iso(-120)}]}]};
const writes=[],errors=[],checks=[],deliveryDays=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  if(ep==='/api/v1/integrations/github-app/complete'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});
   app={...app,installed:true,account:'acme',accountType:'Organization',selection:'selected',repositories:['acme/payments','acme/web'],manageUrl:'https://github.test/organizations/acme/settings/installations/77',received:0};data=app;}
  else if(ep==='/api/v1/integrations/github-app'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});app={...app,rules:b.rules??app.rules,riskyPaths:b.riskyPaths??app.riskyPaths,closeOnKeyword:b.closeOnKeyword??app.closeOnKeyword};data=app;}
  else if(ep===`/api/v1/tasks/${tid}/github-branch`&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});
   links=[...links,{id:'l3',provider:'GitHub',kind:'branch',externalId:'PAY-12-fix-refund-rounding',title:'PAY-12-fix-refund-rounding',url:`https://github.test/${b.repository}/tree/PAY-12-fix-refund-rounding`,repository:b.repository,author:null,state:null,occurredAt:iso(0)}];
   data={name:'PAY-12-fix-refund-rounding',url:`https://github.test/${b.repository}/tree/PAY-12-fix-refund-rounding`,repository:b.repository};}
  else if(ep===`/api/v1/projects/${pid}/release-notes/page`&&method==='POST'){writes.push({ep,q:url.search});data={documentId:'00000000-0000-0000-0000-0000000000d1'};}
  else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
  else{
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','projects.create','tasks.view','tasks.edit','tasks.create','tasks.comment','org.manage','reports.view','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/integrations/github-app')data=app;
   else if(ep==='/api/v1/integrations/git')data=[];
   else if(ep==='/api/v1/integrations/github-app/delivery'){assert.equal(url.searchParams.get('projectId'),pid);deliveryDays.push(Number(url.searchParams.get('days')));data={...delivery,days:Number(url.searchParams.get('days'))};}
   else if(ep===`/api/v1/projects/${pid}/release-notes`)data=notes;
   else if(ep==='/api/v1/me/review-queue')data=queue;
   else if(ep===`/api/v1/tasks/${tid}/dev-links`)data=links;
   else if(ep===`/api/v1/tasks/${tid}`)data={task,subtasks:[]};
   else if(ep===`/api/v1/work-items/${tid}`)data={kind:'task',id:tid,key:task.key,title:task.title,description:null,projectId:pid,projectKey:'PAY',projectName:'Refunds',status:'Review',category:'Active',priority:'High',startDate:null,dueDate:null,isOverdue:false,
    assignee:task.assignee,reporter:task.reporter,version:3,createdAt:task.createdAt,updatedAt:task.updatedAt,completedAt:null,loggedMinutes:0,detail:task,activity:[],channel:null};
   else if(ep===`/api/v1/tasks/${tid}/checklist`)data={items:[],total:0,done:0,progress:0};
   else if(ep===`/api/v1/tasks/${tid}/dependencies`)data={blockedBy:[],blocks:[]};
   else if(ep==='/api/v1/attachments/limits')data={maxFileBytes:10485760,storageLimitBytes:1073741824,storageUsedBytes:0,allowedExtensions:['pdf','png']};
   else if(ep===`/api/v1/projects/${pid}`)data=detail;
   else if(ep.endsWith('/workspace/members'))data=[{userId:user.id,displayName:user.displayName,email:user.email,role:'Owner'}];
   else if(ep==='/api/v1/projects')data={items:[project],page:1,totalPages:1,totalItems:1};
   else if(ep===`/api/v1/projects/${pid}/tasks`)data={items:[task],page:1,totalPages:1,totalItems:1};
   else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
   else if(ep==='/api/v1/reports/summary'||ep==='/api/v1/work-tasks/summary')data=null;
   else if(ep==='/api/v1/agent/command-center')data={greeting:'Good morning, Asha',headline:'Nothing urgent.',since:iso(-60*12),counts:{attention:0,toDecide:0,dueToday:0,overdue:0,blocking:0,checkIns:0,meetingsToday:0,atRisk:0},
     attention:[],today:[],changes:[],health:[],reliability:{kept:0,missed:0,open:0,moved:0},checkIns:[],owe:[],delegations:[]};
   else if(ep==='/api/v1/dashboard')data={counts:{myDueToday:0,myCompletedToday:0,myOpen:1,myOverdue:0,myLoggedMinutesThisWeek:0,openTasks:1,activeProjects:1,totalProjects:1,completedProjects:0,members:4,overdueTasks:0,overallProgress:40},myTasks:[],projects:[],activity:[],myWork:[]};
   else if(ep==='/api/v1/notifications/counts')data={unread:0,needsYou:0,forInfo:0,snoozed:0};
   else if(ep==='/api/v1/notifications')data={items:[],page:1,pageSize:20,totalPages:0,totalItems:0};
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
   else if(ep.endsWith('/ai/usage'))data={month:'2030-01',creditsUsed:20,creditsLimit:200,creditsLeft:180,unlimited:false,maxTier:'deep',attachments:true,actions:true,tiers:['quick','standard','deep'].map((id,i)=>({id,label:id,model:'synthetic',credits:i+1,allowed:true,description:'Preview mode'})),attachmentTypes:[],maxFiles:3,maxImageMb:2,maxDocumentMb:2};
   else if(ep.endsWith('/ai/starters'))data={greeting:'Welcome back',starters:[]};
   else if(ep.endsWith('/ai/insights'))data=[];
   else if(ep.endsWith('/ai/conversations'))data=[];
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep==='/api/v1/chat/projects/unread')data=[];
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
   else if(process.env.DEBUG_EP)console.log('DEFAULT',ep);
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(300);await page.screenshot({path:path.join(out,name),fullPage:true});};
 const waitWrite=async(test)=>{for(let i=0;i<40&&!writes.some(test);i++)await new Promise(r=>setTimeout(r,100));return writes.find(test);};
 let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 page.on('console',async m=>{if(m.type()==='error'){console.log('CONSOLE',m.text().slice(0,300));for(const a of m.args())console.log('ARG',(await a.evaluate(x=>x&&x.stack?x.stack:String(x)).catch(()=>'')).slice(0,1200));}});
 try{

 // Back from GitHub: the installation, the one-time code and the sealed state go to the server, then the address is cleaned.
 await page.goto(origin+'/preview-org/settings/git?installation_id=77&setup_action=install&code=onetime&state=sealed%2Bstate');
 const card=page.getByTestId('github-app');
 await card.getByText('Connected').waitFor();
 const done=await waitWrite(w=>w.ep.endsWith('/github-app/complete'));
 assert.deepEqual(done.b,{installationId:77,setupAction:'install',code:'onetime',state:'sealed+state'});
 for(let i=0;i<20&&page.url().includes('installation_id');i++)await page.waitForTimeout(100);
 assert.ok(!page.url().includes('code='),'the one-time code is removed from the address');
 assert.ok(await card.getByText('acme/web').isVisible());
 assert.ok(await card.getByRole('link',{name:'Repositories on GitHub'}).isVisible());
 checks.push('install');

 // Rules: merged moves to "Shipped", payments is a risky folder, completing on "fixes" stays on.
 await card.getByLabel('Merged').fill('Shipped');
 await card.getByLabel('Risky folders').fill('src/payments\ndb/migrations\n');
 await card.getByRole('button',{name:'Save rules'}).click();
 const rules=await waitWrite(w=>w.ep==='/api/v1/integrations/github-app');
 assert.equal(rules.b.rules.merged,'Shipped');assert.equal(rules.b.rules.opened,'In Review');
 assert.deepEqual(rules.b.riskyPaths,['src/payments','db/migrations']);assert.equal(rules.b.closeOnKeyword,true);
 await shot(page,'settings-1440.png');
 checks.push('rules');

 // The task: the pull request's checks, review wait and risk with reasons; Create branch picks a repository and shows the command.
 // v2: the old task link opens the task in the Work side panel, which shows its pull request; the full task sheet is one ··· away.
 await page.goto(origin+`/preview-org/projects/${pid}?task=${tid}`);
 await page.waitForURL(/\/work\?item=/);
 const side=page.locator('aside.v2-panel');await side.getByText('PAY-12 · Task').waitFor();
 await side.getByTestId('dev-links').getByText('✓ Checks pass').waitFor();
 await side.getByRole('button',{name:'More for this item'}).click();await page.getByRole('menuitem',{name:/All task details/}).click();
 const dialog=page.getByRole('dialog');await dialog.waitFor();
 await dialog.getByRole('heading').first().waitFor();
 // The task as a calm sheet: key and status in pills, the big title, fields as rows. Light, dark and a phone.
 await dialog.getByTestId('task-sheet-meta').waitFor();
 assert.ok(await dialog.getByTestId('task-sheet-meta').getByText('PAY-12').isVisible());
 await page.waitForTimeout(500);await page.screenshot({path:path.join(out,'task-sheet-1440.png')});
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));await page.waitForTimeout(200);
 await page.screenshot({path:path.join(out,'task-sheet-dark-1440.png')});
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(400);
 await page.screenshot({path:path.join(out,'task-sheet-390.png')});
 await page.setViewportSize({width:1440,height:960});await page.waitForTimeout(300);
 const dev=dialog.getByTestId('dev-links');
 for(let i=0;i<30&&!(await dev.count());i++){await page.evaluate(()=>document.querySelectorAll('[role=dialog] *').forEach(e=>{if(e.scrollHeight>e.clientHeight+4)e.scrollTop=e.scrollHeight;}));await page.waitForTimeout(150);}
 await dev.waitFor();await dev.scrollIntoViewIfNeeded();
 assert.ok(await dev.getByText('✓ Checks pass').isVisible());
 assert.ok(await dev.getByText('Waiting for review').isVisible());
 assert.ok(await dev.getByText('High risk 80').isVisible());
 assert.ok(await dev.getByText('First change to src/payments by ravi').isVisible());
 assert.ok(await dev.getByText('+1200 −30 · 1 file').isVisible());
 await dev.getByRole('button',{name:'Create branch'}).click();
 const branchDialog=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Create a branch'})});await branchDialog.waitFor();
 await branchDialog.getByRole('combobox',{name:'Repository'}).click();await page.getByRole('option',{name:'acme/web'}).click();
 await branchDialog.getByRole('button',{name:'Create branch'}).click();
 const made=await waitWrite(w=>w.ep.endsWith('/github-branch'));
 assert.deepEqual(made.b,{repository:'acme/web'});
 await page.getByRole('heading',{name:'Branch created'}).waitFor();
 assert.ok(await page.getByText('git fetch origin && git switch PAY-12-fix-refund-rounding').isVisible());
 await page.waitForTimeout(300);await page.screenshot({path:path.join(out,'task-branch-1440.png')});   // the viewport only: a full-page capture resizes the window under the dialogs
 await page.getByRole('button',{name:'Done'}).click();
 await dev.getByText('branch',{exact:true}).waitFor();
 checks.push('task');

 // The project's Code tab: delivery measures and release notes, saved as a page.
 await page.goto(origin+`/preview-org/projects/${pid}?tab=code`);
 const code=page.getByTestId('code-tab');await code.waitFor();
 await code.getByText('30.5 h').waitFor();
 assert.ok(await code.getByText('12.5%').isVisible());
 assert.ok(await code.getByText('first commit to production, median').isVisible());
 assert.ok(await code.getByRole('link',{name:'acme/payments#42'}).isVisible());
 await code.getByRole('combobox',{name:'Period'}).click();await page.getByRole('option',{name:'Last 6 months'}).click();
 await code.getByRole('combobox',{name:'Period'}).filter({hasText:'Last 6 months'}).waitFor();
 for(let i=0;i<30&&!deliveryDays.includes(180);i++)await page.waitForTimeout(100);
 assert.ok(deliveryDays.includes(180),'the period asks for 180 days');
 await page.waitForTimeout(600);await shot(page,'code-tab-1440.png');
 await code.getByRole('button',{name:'Save as a page'}).click();
 const saved=await waitWrite(w=>w.ep.endsWith('/release-notes/page'));
 assert.match(saved.q,/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
 for(let i=0;i<30&&!page.url().includes('/library/docs/');i++)await page.waitForTimeout(100);
 assert.ok(page.url().includes('/library/docs/00000000-0000-0000-0000-0000000000d1'));
 checks.push('code-tab');

 // Home (a fresh tab: the draft page stub above has no document to show): the assistant's Home shows the review queue, mine first, then mine waiting on others.
 await page.close();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 await page.goto(origin+'/preview-org/');
 const rq=page.getByTestId('review-queue');await rq.waitFor();
 assert.ok(await rq.getByText('1 waiting on you, the oldest 3 days').isVisible());
 assert.ok(await rq.getByText('acme/payments#42').isVisible());
 assert.ok(await rq.getByText('Yours, waiting on others').isVisible());
 assert.ok(await rq.getByText('✗ checks').isVisible());
 await shot(page,'home-review-queue-1440.png');
 await page.goto(origin+'/preview-org/?tab=today');await page.getByTestId('review-queue').getByText('acme/payments#42').waitFor();   // also beside Today's meetings
 checks.push('review-queue');

 // Phone.
 await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/settings/git');await page.getByTestId('github-app').getByText('Connected').waitFor();await page.waitForTimeout(300);
 await fitsPhone(page,'github settings',assert);
 await page.goto(origin+`/preview-org/projects/${pid}?tab=code`);await page.getByTestId('code-tab').getByText('30.5 h').waitFor();await page.waitForTimeout(300);
 await fitsPhone(page,'code tab',assert);
 await shot(page,'code-tab-390.png');
 checks.push('phone');

 assert.deepEqual(errors,[]);
 }catch(e){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.log('URL:',page.url());console.log('BODY:',(await page.locator('body').innerText().catch(()=>'')).slice(0,1500));console.log('errors:',errors);throw e;}
 console.log('github ui ok:',checks.join(', '));
 await ctx.close();
}finally{await browser.close();}
