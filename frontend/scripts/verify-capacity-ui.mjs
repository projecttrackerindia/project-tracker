import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Projects › Portfolio › Capacity (design s-capacity): person × week heatmap, Hours/% toggle, the ✦ rebalance card (Preview / Rebalance) and team totals.
// Harness copied from verify-portfolio-ui. Projects › Portfolio (v2; the old /portfolio): the summary (and one written by the AI), decisions with the date change and the other ways
// to recover that become proposals, money with a warning, capacity over 100%, and under ···: filters in the address, the export, the timeline. Synthetic fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/capacity-ui');
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
const mon=(()=>{const d=new Date();d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);})();
const wk=(i)=>new Date(Date.parse(mon)+i*7*86400000).toISOString().slice(0,10);
const cell=(i,cap,b,leave=0)=>({weekStart:wk(i),capacityMinutes:cap*60,bookedMinutes:b*60,leaveDays:leave,workingDays:5,onLeave:leave>=5,over:leave<5&&b>cap});
const people=[['p1','Leo Park',40,[[40,38],[32,32],[40,54],[40,48],[40,40],[40,36]]],['p2','Sara Kim',40,[[40,36],[32,30],[40,22],[40,26],[40,34],[40,38]]],
 ['p3','Clara Novak',40,[[40,40],[32,32],[40,40],[0,0,5],[40,38],[40,36]]],['p4','Lena Fischer',24,[[24,22],[24,18],[24,24],[24,24],[16,20,2],[24,16]]]]
 .map(([id,name,h,w])=>({userId:id,name,weeklyCapacityMinutes:h*60,weeks:w.map(([c,b,l],i)=>cell(i,c,b,l))}));
const plan={from:mon,weeks:6,scope:'Everyone',available:['Everyone','Me'],entitled:true,weekStarts:[0,1,2,3,4,5].map(wk),people,
 totals:{capacityMinutes:3600*60/10,bookedMinutes:3300*60/10,booked:.92,overWeeks:3,leaveWeeks:1,publicHolidays:0},
 suggestion:{fromUserId:'p1',fromName:'Leo Park',toUserId:'p2',toName:'Sara Kim',firstWeek:wk(2),lastWeek:wk(3),overMinutes:22*60,freeMinutes:32*60,
  tasks:[{id:'t1',title:'Bureau retry queue',minutes:720,dueDate:wk(3)},{id:'t2',title:'Ledger export',minutes:360,dueDate:wk(3)}]}};
const planQueries=[];
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
  if(ep==='/api/v1/ai/operations/jobs'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});await route.fulfill({contentType:'application/json',body:JSON.stringify({data:{id:'job-1'}})});return;}
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
   else if(ep==='/api/v1/resources/plan'){planQueries.push(url.search);data=plan;}
   else if(ep===`/api/v1/project-status/projects/${pay}`){const t=(id,n,title,extra)=>({id,key:'PAY-'+n,title,parentTaskId:null,startDate:'2026-10-01',dueDate:'2026-10-20',originalDueDate:'2026-10-15',delayedDays:5,statusName:'In progress',statusCategory:'Active',statusColor:'#0a84ff',assignee:{id:'u2',name:'Siva Reddy'},overdueDays:0,revisions:1,blockedBy:[],...extra});
     data={project:{id:pay,key:'PAY',name:'Payments',description:null,groupName:'Delivery',startDate:'2026-09-01',dueDate:'2026-11-02',originalDueDate:'2026-10-25',delayedDays:8,status:'Active',health:'AtRisk',progress:40,owner:{id:'u1',name:'Maya Chen'},stats:{},projectType:'Delivery'},
       tasks:[t('t-pay-1',1,'Bulk payout API',{overdueDays:7}),t('t-pay-2',2,'Bank sandbox certification',{blockedBy:[{key:'OPS-4',title:'Sandbox keys from the bank',statusName:'Waiting'}]}),t('t-pay-3',3,'Reconciliation report',{assignee:null,delayedDays:0})],
       changes:[{id:'ch1',scope:'Project',taskId:null,taskKey:null,title:'Payments',previous:'2026-10-25',revised:'2026-11-02',daysShifted:8,reason:'Ravi on leave for a week',dependency:null,changedBy:{id:'u1',name:'Maya Chen'},changedAt:'2026-10-20T10:00:00Z',currentStatus:'Active',currentCategory:null}],delayedTasks:2,blockedTasks:1};}
   else if(ep===`/api/v1/projects/${pay}`)data={project:{id:pay},statuses:[{id:'s-todo',name:'To do',order:0,category:'Todo',color:'#8e8e93'},{id:'s-done',name:'Done',order:2,category:'Done',color:'#30d158'}],stages:[],members:[{userId:'u1',name:'Maya Chen',email:'p@example.com',role:null},{userId:'u2',name:'Siva Reddy',email:'s@example.com',role:null}]};
   else if(ep==='/api/v1/project-status/groups')data=[{id:'g1',name:'Delivery',isActive:true,count:2,projects:[{id:pay,name:'Payments',health:'AtRisk',progress:40,active:10},{id:web,name:'Website',health:'OnTrack',progress:20,active:0}]}];
   else if(ep==='/api/v1/ai/portfolio/brief')data=brief;
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
 await page.goto(origin+'/preview-org/work/projects?view=portfolio&mode=capacity');
 const cap=page.getByRole('region',{name:'Capacity'});await cap.waitFor();
 assert.ok(await page.getByRole('tablist',{name:'Portfolio view'}).getByRole('tab',{name:'Capacity',selected:true}).isVisible(),'Board · Timeline · Capacity');
 assert.ok(planQueries.some(q=>q.includes('weeks=6')),'asks for six weeks');
 const grid=cap.getByRole('table',{name:'Capacity by person and week'});
 assert.equal(await grid.getByRole('columnheader').count(),7,'person + six weeks');
 assert.equal(await grid.getByRole('row').count(),5);
 const leo=grid.getByRole('row').filter({hasText:'Leo Park'});
 assert.equal(await leo.locator('.cp-cell.over').count(),2,'two over-booked weeks for Leo');
 assert.ok((await leo.locator('.cp-cell.over').first().innerText()).includes('54'));
 assert.equal(await grid.getByRole('row').filter({hasText:'Clara Novak'}).locator('.cp-cell.leave').count(),1,'a leave week');
 for(const k of ['Capacity','Booked','Over-booked','Leave'])assert.ok(await cap.getByRole('list',{name:'Legend'}).getByText(k,{exact:true}).isVisible());
 const ai=cap.locator('.cp-ai');
 assert.match(await ai.innerText(),/Leo Park is 22h over in weeks \d+–\d+ while Sara Kim has 32h free\./);
 assert.match(await ai.innerText(),/“Bureau retry queue” \(12h\) and “Ledger export” \(6h\) to Sara Kim/);
 const foot=await cap.locator('.cp-foot').innerText();
 assert.match(foot,/Team total · 6 weeks: 330h booked \/ 360h available \(92%\)/);assert.match(foot,/3 over-booked weeks · 1 leave week · 0 public holidays/);
 checks.push('heatmap');
 await shot(page,'capacity-1440.png');
 await cap.getByRole('tablist',{name:'Show as'}).getByRole('tab',{name:'%'}).click();
 assert.ok((await leo.locator('.cp-cell.over').first().innerText()).includes('135%'));
 checks.push('percent');
 await cap.getByRole('button',{name:'Preview'}).click();
 const sheet=page.getByRole('dialog',{name:'Suggested move'});await sheet.waitFor();
 assert.ok(await sheet.getByText('Bureau retry queue').isVisible());
 await shot(page,'capacity-preview-1440.png');
 await sheet.getByRole('button',{name:'Rebalance'}).click();
 const job=await waitWrite(w=>w.ep==='/api/v1/ai/operations/jobs');assert.equal(job.b.kind,'workload');
 await page.waitForURL(/insights/);
 checks.push('rebalance');
 await page.goto(origin+'/preview-org/work/projects?view=portfolio&mode=capacity');await cap.waitFor();
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));await shot(page,'capacity-dark-1440.png');
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
 await fitsPhone(page,'capacity',assert);await shot(page,'capacity-390.png');
 await cap.getByRole('button',{name:'Preview'}).click();await page.getByRole('dialog',{name:'Suggested move'}).waitFor();await shot(page,'capacity-preview-390.png');
 checks.push('phone');
 assert.deepEqual(errors,[]);
 }catch(e){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.log('URL:',page.url());console.log('errors:',errors);throw e;}
 console.log('capacity ui ok:',checks.join(', '));
 await ctx.close();
}finally{await browser.close();}
