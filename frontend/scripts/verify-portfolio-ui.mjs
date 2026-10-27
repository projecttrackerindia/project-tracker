import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Projects › Portfolio (v2; the old /portfolio): the summary (and one written by the AI), decisions with the date change and the other ways
// to recover that become proposals, money with a warning, capacity over 100%, and under ···: filters in the address, the export, the timeline. Synthetic fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/portfolio-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false,mfaEnabled:true};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const pay='00000000-0000-0000-0000-0000000000a1', web='00000000-0000-0000-0000-0000000000a2', ravi='00000000-0000-0000-0000-0000000000b1';
const day=(n)=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
const risk=(id,key,name,health,slip,level)=>({projectId:id,key,name,group:'Delivery',health,progress:40,owner:'Asha Rao',startDate:day(-40),dueDate:day(7),delayedDays:0,openTasks:8,overdueTasks:2,blockedTasks:1,
 openActionItems:0,overdueActionItems:0,finishedLast28Days:6,inProgressTasks:2,projectedFinish:day(7+slip),projectedSlipDays:slip,confidence:'medium',score:level==='High'?6:1,level,reasons:['2 overdue tasks of 8 open']});
const brief={asOf:day(0),projects:2,onTrack:1,atRisk:1,delayed:0,onHold:0,overdueTasks:2,blockedTasks:1,openActionItems:0,overdueActionItems:0,dateChangesLast30Days:0,headlines:['2 active projects: 1 on track, 1 at risk, 0 delayed.'],
 ranked:[risk(pay,'PAY','Payments','AtRisk',6,'High'),risk(web,'WEB','Website','OnTrack',-2,'Low')],recentSlips:[],stretched:[]};
const decision={projectId:pay,key:'PAY',name:'Payments',headline:'PAY finishes 6 days late (6 Nov, due 31 Oct): Ravi Kumar is on leave from 3 Nov (4 days) with 5 open tasks and 2 tasks were added in the last 2 weeks and 1 finished.',
 causes:['Ravi Kumar is on leave from 3 Nov (4 days) with 5 open tasks','2 tasks were added in the last 2 weeks and 1 finished','1 task waits on unfinished work'],slipDays:6,dueDate:day(7),finish:day(13),confidence:'medium',waitingProposals:0,
 options:[{id:'move_person',kind:'move_person',title:'Move Jyothsna Reddy onto PAY for a week',effect:'1 day late (1 Nov)',finish:day(8),slipDays:1,steps:['Give PAY-14 “Bank certification” to Jyothsna Reddy','Give PAY-15 “Refund report” to Jyothsna Reddy'],why:'Jyothsna Reddy is at 30% over the next 2 weeks.',personId:'j1'},
  {id:'cut_scope',kind:'cut_scope',title:'Take 2 lower-priority tasks out of PAY',effect:'on time (30 Oct)',finish:day(6),slipDays:-1,steps:['Take out PAY-31 “Export to CSV” (Low)','Take out PAY-32 “Dark theme” (Low)'],why:'',personId:null},
  {id:'accept_date',kind:'accept_date',title:`Accept the new date, 6 Nov`,effect:'on time against the new date',finish:day(13),slipDays:0,steps:['Move PAY\'s delivery date'],why:'',personId:null}]};
const board=()=>({asOf:day(0),filter:{},brief,decisions:[decision],summary:'2 active projects: 1 on track, 1 at risk, 0 delayed. 1 decision this week, the biggest: PAY finishes 6 days late.',
 owners:[{id:user.id,name:'Asha Rao'},{id:ravi,name:'Ravi Kumar'}],groups:[{id:'g1',name:'Delivery'}],
 money:{entitled:true,showMoney:true,currency:'INR',budget:500000,spent:310000,forecast:560000,overrunning:1,burn:['May','Jun','Jul','Aug','Sep','Oct'].map((m,i)=>({month:`${m} 2026`,cost:20000+i*15000})),notes:[],
  projects:[{projectId:pay,key:'PAY',name:'Payments',budget:300000,spent:240000,forecast:390000,overrun:90000,usedShare:.8,burn:[],warning:'Forecast 3,90,000 INR is 30% over the 3,00,000 budget',budgetHours:null,hoursUsed:400,remainingHours:150,peopleWithoutRate:0,basis:'spent so far plus the open estimates'},
   {projectId:web,key:'WEB',name:'Website',budget:200000,spent:70000,forecast:170000,overrun:null,usedShare:.35,burn:[],warning:null,budgetHours:null,hoursUsed:120,remainingHours:60,peopleWithoutRate:0,basis:'spent so far plus the open estimates'}]},
 capacity:{from:day(-2),to:day(25),people:5,over:[{userId:ravi,name:'Ravi Kumar',load:138,leaveDays:4,unestimatedTasks:1,projects:[{projectId:pay,key:'PAY',name:'Payments',minutes:3600,tasks:5},{projectId:web,key:'WEB',name:'Website',minutes:1200,tasks:2}],
  weeks:[0,1,2,3].map(i=>({weekStart:day(-2+i*7),capacityMinutes:2400,demandMinutes:[3600,3000,2000,900][i],load:[150,125,83,38][i]}))}],projectsAtRisk:[{projectId:pay,key:'PAY',name:'Payments',minutes:3600,tasks:5}],notes:['1 task has no estimate and counts as 4 hours.']}});
const timeline={from:day(-40),to:day(60),projects:[
 {id:pay,key:'PAY',name:'Payments',health:'AtRisk',group:'Delivery',start:day(-40),due:day(7),originalDue:day(0),forecast:day(13),progress:40,milestones:[{id:'m1',name:'UAT',due:day(2),status:'InProgress'}],dependsOn:[web]},
 {id:web,key:'WEB',name:'Website',health:'OnTrack',group:'Delivery',start:day(-10),due:day(40),originalDue:null,forecast:day(35),progress:20,milestones:[],dependsOn:[]}]};
const writes=[],errors=[],checks=[],boardQueries=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block',acceptDownloads:true});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  if(ep==='/api/v1/portfolio/export'){writes.push({ep,q:url.search});await route.fulfill({status:200,contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',headers:{'content-disposition':'attachment; filename="portfolio.xlsx"'},body:Buffer.from('PK synthetic')});return;}
  let data=[];
  if(ep===`/api/v1/portfolio/decisions/${pay}/apply`&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data={proposals:2,message:'2 proposals are waiting in PAY › Agent for approval.'};}
  else if(ep==='/api/v1/portfolio/summary'&&method==='POST'){writes.push({ep,q:url.search});data={text:'Payments is the one project at risk: it is likely to land six days late because Ravi is on leave. Moving Jyothsna onto it for a week brings it to one day late.',model:'gemini-synthetic',at:new Date().toISOString(),cached:false};}
  else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
  // Present › project facts: the room's actions save at once.
  else if(ep==='/api/v1/tasks/t-pay-1/move'&&method==='PATCH'){writes.push({ep,b:req.postDataJSON()});data={id:'t-pay-1'};}
  else if(ep==='/api/v1/tasks/t-pay-2/comments'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data={id:'c1'};}
  else if(ep===`/api/v1/projects/${pay}/action-items`&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data={id:'a1'};}
  else{
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','tasks.view','org.manage','reports.view','reports.broad','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3,RESOURCE_MANAGEMENT:1}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/portfolio/board'){boardQueries.push(url.search);data=board();}
   else if(ep==='/api/v1/portfolio/timeline')data=timeline;
   else if(ep===`/api/v1/project-status/projects/${pay}`){const t=(id,n,title,extra)=>({id,key:'PAY-'+n,title,parentTaskId:null,startDate:'2026-10-01',dueDate:'2026-10-20',originalDueDate:'2026-10-15',delayedDays:5,statusName:'In progress',statusCategory:'Active',statusColor:'#0a84ff',assignee:{id:'u2',name:'Siva Reddy'},overdueDays:0,revisions:1,blockedBy:[],...extra});
     data={project:{id:pay,key:'PAY',name:'Payments',description:null,groupName:'Delivery',startDate:'2026-09-01',dueDate:'2026-11-02',originalDueDate:'2026-10-25',delayedDays:8,status:'Active',health:'AtRisk',progress:40,owner:{id:'u1',name:'Prasanna Krishna'},stats:{},projectType:'Delivery'},
       tasks:[t('t-pay-1',1,'Bulk payout API',{overdueDays:7}),t('t-pay-2',2,'Bank sandbox certification',{blockedBy:[{key:'OPS-4',title:'Sandbox keys from the bank',statusName:'Waiting'}]}),t('t-pay-3',3,'Reconciliation report',{assignee:null,delayedDays:0})],
       changes:[{id:'ch1',scope:'Project',taskId:null,taskKey:null,title:'Payments',previous:'2026-10-25',revised:'2026-11-02',daysShifted:8,reason:'Ravi on leave for a week',dependency:null,changedBy:{id:'u1',name:'Prasanna Krishna'},changedAt:'2026-10-20T10:00:00Z',currentStatus:'Active',currentCategory:null}],delayedTasks:2,blockedTasks:1};}
   else if(ep===`/api/v1/projects/${pay}`)data={project:{id:pay},statuses:[{id:'s-todo',name:'To do',order:0,category:'Todo',color:'#8e8e93'},{id:'s-done',name:'Done',order:2,category:'Done',color:'#30d158'}],stages:[],members:[{userId:'u1',name:'Prasanna Krishna',email:'p@example.com',role:null},{userId:'u2',name:'Siva Reddy',email:'s@example.com',role:null}]};
   else if(ep==='/api/v1/project-status/groups')data=[{id:'g1',name:'Delivery',isActive:true,count:2,projects:[{id:pay,name:'Payments',health:'AtRisk',progress:40,active:10},{id:web,name:'Website',health:'OnTrack',progress:20,active:0}]}];
   else if(ep==='/api/v1/ai/portfolio/brief')data=brief;
   else if(ep===`/api/v1/project-status/projects/${pay}/weekly`)data={projectId:pay,projectName:'Payments',from:day(-6),to:day(0),health:'At risk',text:'',moved:2,slipped:1,risks:1,next:2,canSend:true,projectKey:'PAY',week:44,
     verdict:'Set at risk by hand: the bank has not shared the sandbox keys.',progress:40,movedItems:[{text:'PAY-7 Payout retries'},{text:'PAY-9 Webhook signatures'}],slippedItems:[{text:'PAY-2 Bank sandbox certification · to 2 Nov'}],riskItems:[],nextItems:[{text:'PAY-1 Bulk payout API'},{text:'PAY-3 Reconciliation report'}]};
   else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
   else if(ep==='/api/v1/notifications/counts')data={unread:0,needsYou:0,forInfo:0,snoozed:0};
   else if(ep==='/api/v1/notifications')data={items:[],page:1,pageSize:20,totalPages:0,totalItems:0};
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep==='/api/v1/chat/projects/unread')data=[];
   else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(300);await page.screenshot({path:path.join(out,name),fullPage:true});};
 const waitWrite=async(test)=>{for(let i=0;i<40&&!writes.some(test);i++)await new Promise(r=>setTimeout(r,100));return writes.find(test);};
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 try{
 // v2: the old /portfolio is Projects › Portfolio: the AI summary, the decisions (old date → new date, Accept, other ways), money, capacity;
 // filters, export and the roadmap are under ···.
 await page.goto(origin+'/preview-org/portfolio');await page.waitForURL(/\/work\/projects\?view=portfolio$/);
 const summary=page.getByRole('region',{name:'Summary'});await summary.waitFor();
 assert.ok((await summary.innerText()).trim().length>0,'one AI sentence');
 assert.ok(await page.getByRole('tablist',{name:'Portfolio view'}).isVisible(),'Board · Timeline · Present');
 assert.ok(await page.locator('.pf-tile').count()===3,'three status tiles');
 assert.equal(await page.getByRole('region',{name:'Projects that need attention'}).count(),0,'no separate Needs attention');
 checks.push('summary');

 // Decisions: how late, the project, why in one line, and the date change as the hero; the other ways to recover with their effect.
 const decisions=page.getByRole('region',{name:'Decisions this week'});
 const dec=decisions.locator('.pf-dec[data-project="PAY"]');
 assert.equal(await decisions.locator('.pf-dec[data-project="PAY"]').count(),1,'one card per project');
 await dec.getByText('PAY · 6 days late',{exact:true}).waitFor();
 assert.ok(await dec.getByRole('heading',{name:/Payments/}).isVisible());
 assert.ok(await dec.locator('.pf-dec-dates s').isVisible()&&await dec.locator('.pf-dec-dates b').isVisible(),'due and forecast dates');
 assert.ok(await dec.getByRole('button',{name:/^Propose /}).isVisible(),'Propose the forecast date');
 // Add people opens why it moved and the other ways to recover.
 await dec.getByRole('button',{name:'Add people'}).click();
 assert.ok(await dec.getByText('Ravi Kumar is on leave from 3 Nov',{exact:false}).first().isVisible());
 const move=dec.getByRole('listitem').filter({hasText:'Move Jyothsna Reddy onto PAY for a week'});
 assert.ok(await move.getByText('1 day late').isVisible());
 assert.ok(await move.getByText('Give PAY-14 “Bank certification” to Jyothsna Reddy').isVisible());
 assert.ok(await dec.getByText('on time (30 Oct)').isVisible());
 await move.getByRole('button',{name:'Propose this'}).click();
 const applied=await waitWrite(w=>w.ep.endsWith('/apply'));
 assert.equal(applied.b.option,'move_person');
 await page.getByText('2 proposals are waiting in PAY › Agent for approval.').waitFor();
 checks.push('decisions');

 // Money and capacity.
 const money=page.getByRole('region',{name:'Money'});
 assert.ok(await money.getByText('Forecast 3,90,000 INR is 30% over the 3,00,000 budget').isVisible());
 assert.equal(await money.getByRole('img',{name:'Cost by month'}).locator('div').count(),6);
 const cap=page.getByRole('region',{name:'Capacity'});
 assert.ok(await cap.getByText('1 over 100%').isVisible());
 const raviRow=cap.getByRole('row').filter({hasText:'Ravi Kumar'});
 assert.ok(await raviRow.getByText('150%').isVisible());
 assert.ok(await raviRow.getByText('4 days leave',{exact:false}).isVisible());
 assert.ok(await cap.getByText('Projects at risk:',{exact:false}).isVisible());
 await shot(page,'board-1440.png');
 checks.push('money-capacity');

 // Written by the AI for the meeting.
 await summary.getByRole('button',{name:'Write it for the meeting'}).click();
 // v2: one sentence on the page (the full write-up is kept on hover).
 await summary.getByText('Payments is the one project at risk',{exact:false}).waitFor();assert.ok(await summary.locator('[title*="Moving Jyothsna"]').count()>0||(await summary.innerText()).includes('Moving Jyothsna'),'full write-up kept');
 assert.ok(await summary.getByText('Written by the AI',{exact:false}).isVisible());
 checks.push('ai-summary');

 // Filters (··· › Filters) go into the address and the query; export (··· › Export to Excel) uses them.
 const more=async(item)=>{await page.getByRole('button',{name:'More on Portfolio'}).click();await page.getByRole('menu',{name:'More on Portfolio'}).getByRole('menuitem',{name:item}).click();};
 await more(/^Filters/);
 await page.getByRole('group',{name:'Filters'}).getByRole('combobox',{name:'Owner'}).click();await page.getByRole('option',{name:'Ravi Kumar'}).click();
 for(let i=0;i<100&&!page.url().includes(`owner=${ravi}`);i++)await page.waitForTimeout(100);
 assert.ok(page.url().includes(`owner=${ravi}`),page.url());
 for(let i=0;i<30&&!boardQueries.some(qs=>qs.includes(`ownerId=${ravi}`));i++)await page.waitForTimeout(100);
 assert.ok(boardQueries.some(qs=>qs.includes(`ownerId=${ravi}`)));
 await page.getByRole('button',{name:'More on Portfolio'}).click();
 assert.ok(await page.getByRole('menu',{name:'More on Portfolio'}).getByRole('menuitem',{name:/^Filters · 1/}).isVisible(),'··· counts the filters set');
 const [dl]=await Promise.all([page.waitForEvent('download'),page.getByRole('menu',{name:'More on Portfolio'}).getByRole('menuitem',{name:/^Export to Excel/}).click()]);
 assert.match(dl.suggestedFilename(),/portfolio-.*\.xlsx/);
 const exp=await waitWrite(w=>w.ep==='/api/v1/portfolio/export');
 assert.match(exp.q,/format=xlsx/);assert.match(exp.q,new RegExp(`ownerId=${ravi}`));
 checks.push('filters-export');

 // Timeline (··· › Timeline): bars, the slip after the due date, the original due date as a ghost, milestones and dependencies.
 await page.getByRole('tablist',{name:'Portfolio view'}).getByRole('tab',{name:'Timeline'}).click();
 const tl=page.getByRole('region',{name:'Timeline'});await tl.waitFor();
 { const u=new URL(page.url()); assert.equal(u.searchParams.get('view'),'portfolio'); assert.equal(u.searchParams.get('mode'),'timeline'); }
 assert.equal(await tl.locator('.pf-g-row').count(),2);
 assert.equal(await tl.locator('.pf-g-row').first().locator('.pf-g-plan').count(),1);
 assert.equal(await tl.locator('.pf-g-row').first().locator('.pf-g-fc').count(),1);
 assert.equal(await tl.locator('.pf-g-today').count(),1);
 await shot(page,'timeline-1440.png');
 checks.push('timeline');

 // Drag a card to another column: a sheet explains and does the real thing (flag the risk as a follow-up on the project).
 await page.getByRole('tablist',{name:'Portfolio view'}).getByRole('tab',{name:'Board'}).click();await page.locator('.pf-board .pf-card[draggable="true"]').first().waitFor();
 {const card=page.locator('.pf-board .pf-card[draggable="true"]',{hasText:'Payments'}).first();
  {const target=page.locator('.pf-colwrap.late');await card.dragTo(target);
   const sheet=page.getByRole('dialog',{name:/Move Payments to Late/});await sheet.waitFor();
   await sheet.getByLabel('What is the risk?').fill('Bank sandbox keys not shared');await shot(page,'board-drop-1440.png');
   await sheet.getByRole('button',{name:'Flag it'}).click();await sheet.waitFor({state:'detached'});
   assert.ok(writes.some(w=>w.ep===`/api/v1/projects/${pay}/action-items`&&/Late: Bank sandbox keys/.test(w.b.title)&&w.b.priority==='Critical'),'the drop flags the project with a follow-up');
   await page.locator('.pf-flag').first().waitFor();checks.push('board-drag-flag');}}
 await page.getByRole('tablist',{name:'Portfolio view'}).getByRole('tab',{name:'Present'}).click();
 const pres=page.getByRole('dialog',{name:'Present decisions'});await pres.waitFor();
 assert.ok(await pres.getByText(/^1 of \d+$/).isVisible());
 // A project slide: lead, dates, open work with owners, dependencies and the reason the date moved — and live actions.
 const payTab=pres.getByRole('tab').filter({hasText:'Payments'});
 if(await payTab.count()){await payTab.first().click();
  const facts=pres.getByRole('complementary',{name:'Payments details'});await facts.waitFor();
  const ft=await facts.innerText();assert.match(ft,/Lead[\s\S]*Prasanna Krishna/i);assert.match(ft,/Started[\s\S]*1 Sep/i);assert.match(ft,/was 25 Oct/);
  assert.match(ft,/PAY-1[\s\S]*Siva Reddy[\s\S]*7d overdue/);assert.match(ft,/Waiting on OPS-4/);assert.match(ft,/Ravi on leave/);
  await shot(page,'present-facts-1440.png');
  await facts.getByRole('button',{name:'Mark PAY-1 done'}).click();await facts.getByText('PAY-1').waitFor({state:'detached'});
  assert.ok(writes.some(w=>w.ep==='/api/v1/tasks/t-pay-1/move'&&w.b.statusId==='s-done'),'done moves the task to Done');
  await facts.locator('li',{hasText:'PAY-2'}).getByRole('button',{name:'Remark'}).click();
  await facts.getByRole('textbox',{name:'Remark on PAY-2'}).fill('Bank to share keys by Thursday');await facts.getByRole('button',{name:'Save'}).click();
  await page.waitForFunction(()=>true);await facts.getByRole('textbox',{name:'Remark on PAY-2'}).waitFor({state:'detached'});
  assert.ok(writes.some(w=>w.ep==='/api/v1/tasks/t-pay-2/comments'&&/Bank to share keys/.test(w.b.body)),'remark saved as a task comment');
  await facts.getByRole('textbox',{name:'Follow-up'}).fill('Escalate sandbox keys');await facts.getByRole('combobox',{name:'Owner'}).selectOption('u2');
  await facts.getByRole('button',{name:'Add',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Follow-up"]')?.value);
  assert.ok(writes.some(w=>w.ep===`/api/v1/projects/${pay}/action-items`&&w.b.assigneeId==='u2'),'follow-up saved with its owner');
  checks.push('present-facts-actions');
  // Weekly reports: each project's latest weekly report joins as the slide after its decision; its health is the one shown everywhere (set by hand included).
  const before=await pres.getByRole('tab').count();
  await pres.getByRole('button',{name:'+ Weekly reports'}).click();
  assert.equal(await pres.getByRole('button',{name:'✓ Weekly reports'}).getAttribute('aria-pressed'),'true');
  assert.equal(await pres.getByRole('tab').count(),before*2-1,'one weekly slide per decision');
  assert.equal(await pres.getByRole('tab',{selected:true}).innerText().then(t=>/Payments/.test(t)&&!/Weekly/.test(t)),true,'stays on the same project');
  await pres.getByRole('tab').filter({hasText:'Weekly · Payments'}).click();
  const wk=pres.getByRole('region',{name:'Weekly report: Payments'});
  await wk.getByText('Set at risk by hand: the bank has not shared the sandbox keys.').waitFor();
  assert.match(await wk.locator('.pf-slide-ey').innerText(),/Weekly report · Week 44 · At risk/i);
  assert.match(await wk.locator('.pf-slide-ey').getAttribute('class'),/\brisk\b/);
  const wt=await wk.innerText();assert.match(wt,/Moved · 2[\s\S]*PAY-7 Payout retries/i);assert.match(wt,/Slipped · 1[\s\S]*PAY-2/i);assert.match(wt,/Next week · 2[\s\S]*PAY-3/i);
  await shot(page,'present-weekly-1440.png');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'present fits the phone');
  await shot(page,'present-weekly-390.png');await page.setViewportSize({width:1440,height:900});
  checks.push('present-weekly-report');}
 await page.keyboard.press('Escape');await pres.waitFor({state:'detached'});
 await page.getByRole('tablist',{name:'Portfolio view'}).getByRole('tab',{name:'Board'}).click();
 assert.ok(await page.getByRole('region',{name:'Board'}).isVisible());
 await page.getByRole('region',{name:'Summary'}).waitFor();
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));await shot(page,'board-dark-1440.png');
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
 await page.setViewportSize({width:820,height:1000});await shot(page,'board-820.png');
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('region',{name:'Summary'}).waitFor();await page.waitForTimeout(300);
 await fitsPhone(page,'portfolio board',assert);await shot(page,'board-390.png');
 checks.push('phone');
 assert.deepEqual(errors,[]);
 }catch(e){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.log('URL:',page.url());console.log('errors:',errors);throw e;}
 console.log('portfolio ui ok:',checks.join(', '));
 await ctx.close();
}finally{await browser.close();}
