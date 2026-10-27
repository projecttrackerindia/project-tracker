import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';
const origin='https://projecttracker-preview.test',dist=path.resolve('dist'),out=path.resolve('test-results/layout-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Alexandra Montgomery',email:'preview@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:2};
const pid='00000000-0000-0000-0000-000000000003';
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const futureDay=new Date(today+'T00:00:00Z');futureDay.setUTCDate(futureDay.getUTCDate()+8);const plannedDate=futureDay.toISOString().slice(0,10);
const leaveQueries=[];
const project={id:pid,key:'DEMO',name:'Infrastructure delivery',description:'A synthetic project for responsive layout verification.',groupName:'Delivery',status:'Active',health:'OnTrack',progress:33,active:67,startDate:'2026-10-01',dueDate:'2027-07-09',originalDueDate:'2027-07-09',delayedDays:0,projectType:'NewProject',stats:{total:3,done:1,inProgress:2,cancelled:0,todo:0,overdue:0}};
const tasks=[0,1,2].map(i=>({id:`10000000-0000-0000-0000-00000000000${i+1}`,key:`DEMO-${i+1}`,title:['Review integration traffic and verify the approved activity with evidence','Coordinate environment maintenance and record change approval','Prepare deployment access documentation'][i],parentTaskId:null,startDate:'2026-10-05',dueDate:'2026-10-20',originalDueDate:null,delayedDays:0,statusName:i?'In Progress':'Done',statusCategory:i?'InProgress':'Done',statusColor:i?'#7c3aed':'#059669',assignee:{id:user.id,name:user.displayName},overdueDays:0,revisions:0,blockedBy:[]}));
const usage={month:'2026-10',creditsUsed:240,creditsLimit:1000,creditsLeft:740,unlimited:false,maxTier:'deep',attachments:true,actions:true,tiers:[],attachmentTypes:[],maxFiles:3,maxImageMb:2,maxDocumentMb:2};
const errors=[],checks=[],writes=[];let leaves=[];let cardProjects=null;
const owner=(id,name)=>({id:`30000000-0000-0000-0000-00000000000${id}`,name});
const card=(n,name,key,desc,group,health,total,done,progress,priority,type,who,due)=>({id:`40000000-0000-0000-0000-00000000000${n}`,key,name,description:desc,status:'Active',priority,owner:who,teamId:null,teamName:'MULESOFT',
 startDate:'2026-10-01',dueDate:due,progress,health,stats:{total,done,inProgress:total-done,overdue:0,cancelled:0,todo:0,blocked:0},memberCount:2,version:1,position:n,enforceDependencies:false,projectGroupId:null,projectGroupName:group,projectType:type,deliveryMethod:'Waterfall'});
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');});
 await ctx.route('**/*',async route=>{
  const url=new URL(route.request().url()),ep=url.pathname,method=route.request().method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));const type={'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream';await route.fulfill({contentType:type,body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  if(ep==='/api/v1/time/leave'&&method==='POST'){const b=route.request().postDataJSON();assert.deepEqual(b.userIds,[user.id]);assert.equal(b.from,b.to);assert.match(b.requestId,/^[0-9a-f-]{36}$/);writes.push(b);leaves=[{id:pid,userId:user.id,date:b.from,note:b.note,status:'Planned'}];data=leaves;}
  else if(ep==='/api/v1/ai/credits/budgets'&&method==='PUT'){const b=route.request().postDataJSON();assert.deepEqual(b,{scope:'user',subjectId:user.id,monthlyLimit:150,enabled:true});writes.push(b);}
  else{assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['org.manage','work.view','work.edit','work.create','reports.view','reports.broad'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3,RESOURCE_MANAGEMENT:1}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/chat/projects/unread')data=[];
   else if(ep==='/api/v1/projects'&&cardProjects)data={items:cardProjects,page:1,totalPages:1,totalItems:cardProjects.length};
   else if(ep==='/api/v1/projects'||ep==='/api/v1/work-tasks')data={items:[],page:1,totalPages:0,totalItems:0};
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/workspace/members'))data=[{userId:user.id,displayName:user.displayName,email:user.email,role:'Owner'}];
   else if(ep.endsWith('/project-status/groups'))data=[{id:pid,name:'Delivery',isActive:true,count:1,projects:[project]}];
   else if(ep.includes('/project-status/projects/'))data={project,tasks,changes:[],delayedTasks:0,blockedTasks:0};
   // v2: a portfolio link to one project opens the one project page.
   else if(ep===`/api/v1/projects/${pid}`)data={project:{...card(0,project.name,'DEMO',project.description,'Delivery','AtRisk',3,1,33,'High','NewProject',owner(2,'Prasanna Krishna'),'2027-07-09'),id:pid},
    stages:['Requirements and Planning','Code Review','User Acceptance Testing','Production Deployment'].map((name,i)=>({id:`50000000-0000-0000-0000-00000000000${i}`,name,order:i,plannedStart:null,plannedEnd:null,actualStart:null,actualEnd:null,status:i?'Pending':'InProgress',effectiveStatus:i?'Pending':'InProgress',owner:null,assignee:null,description:null,taskTotal:1,taskDone:0,locked:i>0,lockedBy:null,openIssues:0,totalIssues:0})),
    statuses:[],members:[{userId:user.id,name:user.displayName,email:user.email,role:'Owner'}]};
   else if(ep==='/api/v1/calendar')data=['Requirements and Planning','Code Review','User Acceptance Testing','Production Deployment'].map((title,i)=>({id:`20000000-0000-0000-0000-00000000000${i}`,type:'stage',title,date:today,status:'Pending',category:'Todo',overdue:false,projectId:pid,projectName:'Long integration project name with a descriptive delivery title',priority:'Medium'}));
   else if(ep==='/api/v1/ai/status')data={enabled:true,configured:true,entitled:true,allowedHere:true,model:'synthetic',provider:'Gemini'};
   else if(ep==='/api/v1/ai/portfolio/brief')data={ranked:[{projectId:pid,key:'DEMO',name:project.name,group:'Delivery',health:'AtRisk',progress:33,owner:null,startDate:'2026-10-01',dueDate:'2027-07-09',delayedDays:0,openTasks:2,overdueTasks:0,blockedTasks:0,openActionItems:0,overdueActionItems:1,finishedLast28Days:0,inProgressTasks:2,projectedFinish:null,projectedSlipDays:null,confidence:'none',score:5,level:'High',reasons:['Nothing has finished in the last 4 weeks, and 2 tasks are still open.','1 action item is overdue.']}],projects:1,totals:{}};
   else if(ep==='/api/v1/ai/usage')data=usage;
   else if(ep==='/api/v1/ai/usage/report')data={month:'2026-10',creditsUsed:240,creditsLimit:1000,unlimited:false,answers:80,failed:0,byTier:[{tier:'quick',answers:40,credits:40},{tier:'standard',answers:40,credits:200}],people:[{userId:user.id,name:user.displayName,answers:80,credits:240,byTier:[{tier:'quick',answers:40},{tier:'standard',answers:40}]}]};
   else if(ep==='/api/v1/ai/credits/balance')data={spent:240,reserved:20,available:740,unlimited:false};
   else if(ep==='/api/v1/ai/starters')data={greeting:'Welcome',starters:[]};
   else if(ep==='/api/v1/ai/profile')data={detailLevel:0,detailLabel:'Normal length',notes:null,learned:[]};
   else if(ep==='/api/v1/time')data={from:url.searchParams.get('from'),to:url.searchParams.get('to'),user:{id:user.id,name:user.displayName},entries:[],byDay:[],totalMinutes:0,billableMinutes:0};
   else if(ep==='/api/v1/time/leave'){const from=url.searchParams.get('from'),to=url.searchParams.get('to');leaveQueries.push({from,to});data=leaves.filter(l=>l.date>=from&&l.date<=to);}
   else if(ep==='/api/v1/time/approvals')data={pending:[],people:[]};
   else if(ep==='/api/v1/time/grid'){const t=new Date(`${today}T00:00:00Z`),mon=url.searchParams.get('weekStart')??new Date(t.getTime()-((t.getUTCDay()+6)%7)*864e5).toISOString().slice(0,10);const days=[0,1,2,3,4,5,6].map(i=>{const d=new Date(new Date(`${mon}T00:00:00Z`).getTime()+i*864e5).toISOString().slice(0,10);return {date:d,minutes:0,targetMinutes:i<5?480:0,weekend:i>=5,leave:false,leaveNote:null,future:d>today,meetings:0,meetingMinutes:0};});data={weekStart:mon,weekEnd:days[6].date,user:{id:user.id,name:user.displayName},mine:true,editable:true,locked:false,status:'NotSubmitted',days,rows:[],suggestions:[],totalMinutes:0,billableMinutes:0,targetMinutes:2400,overtimeMinutes:0,missingDays:0,running:null};}
   else if(ep==='/api/v1/time/week')data={weekStart:url.searchParams.get('weekStart'),weekEnd:today,userId:user.id,totalMinutes:0,billableMinutes:0,status:'NotSubmitted',locked:false,canSubmit:false,canWithdraw:false,canReview:false,entitled:true};
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 let page;
 async function open(url,selector,width){await page?.close();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width,height:1000});await page.goto(origin+url);try{await page.locator(selector).waitFor({timeout:15000});}catch(e){await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({url:page.url(),errors,body:await page.locator('body').innerText()}));throw e;}await page.evaluate(()=>document.fonts.ready);}
 async function capture(name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,name+' viewport overflow');assert.deepEqual(await cutOff(page),[],'cut off at the right edge');await page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});checks.push(name);}
 for(const width of [1440,1080,820,390]){
  // v2: Portfolio has no project tree or summary page of its own: a portfolio link to a project opens the one project page.
  await open('/preview-org/portfolio?project='+pid,'.pp-head h1',width);assert.ok(new URL(page.url()).pathname.endsWith(`/work/projects/${pid}`),page.url());
  // The summary says where it stands, from the portfolio's forecast (nothing finished in 4 weeks, so no forecast yet).
  await page.locator('.pp-head h1').waitFor();   // v2 Journey layout: the summary moved into the Overview cards
  assert.equal(await page.locator('.pp-head').evaluate(el=>[...el.children].every(c=>c.getBoundingClientRect().right<=el.getBoundingClientRect().right+1)),true,'Project heading stays inside the page');
  const inside=await page.locator('.pp-stage').evaluateAll(chips=>chips.every(c=>{const box=c.getBoundingClientRect(),card=c.closest('.pp-stages').getBoundingClientRect();return box.left>=card.left-1&&box.right<=card.right+1;}));
  assert.equal(inside,true,'Stage chips stay inside their card');await capture('project-page-'+width);
 }
 for(const width of [1440,390]){
  // v2: /calendar is Home › Calendar, one calm week (the month agenda and its "Show" filters are gone). Long titles stay inside their day.
  await open('/preview-org/calendar','[data-testid="week-planner"]',width);assert.match(new URL(page.url()).search,/tab=calendar/);
  await page.locator('.wp-col .wp-e').nth(3).waitFor();
  await page.evaluate(()=>scrollTo(0,0));await capture('calendar-top-'+width);
  const inside=await page.locator('.wp-col .wp-e').evaluateAll(items=>items.map(el=>{const day=el.closest('.wp-col').getBoundingClientRect(),box=el.getBoundingClientRect();return box.left>=day.left-1&&box.right<=day.right+1;}));
  assert.ok(inside.length===4&&inside.every(Boolean),'Calendar entries stay inside their day');await page.locator('[data-testid="week-planner"]').scrollIntoViewIfNeeded();await capture('calendar-'+width);
 }
 await open('/preview-org/settings/ai/usage','.ai-budgets',1440);
 await page.locator('.ai-budgets').scrollIntoViewIfNeeded();await capture('credit-budgets-1440');
 const person=page.getByRole('combobox',{name:'Person',exact:true});await person.click();await page.getByRole('option',{name:user.displayName,exact:true}).click();await page.getByLabel('Monthly credits').fill('150');await page.getByRole('button',{name:'Save cap',exact:true}).click();await page.waitForTimeout(100);assert.equal(writes.length,1,'Budget saves only reviewed values');
 await open('/preview-org/settings/ai/usage','.ai-budgets',390);await page.locator('.ai-budgets').scrollIntoViewIfNeeded();await capture('credit-budgets-390');
 // v2: the full timesheet (with planned leave) is Insights › Time › Full timesheet.
 await open('/preview-org/insights?tab=time&s=week','.planned-leave',1440);await page.getByRole('button',{name:'Plan leave',exact:true}).click();await page.getByLabel('First day').fill(plannedDate);await page.getByLabel('Last day').fill(plannedDate);await page.getByLabel('Note (optional)').fill('Handover prepared. HR approval requested separately.');await page.getByRole('button',{name:'Review leave',exact:true}).click();assert.equal(writes.length,1,'Review does not write');await page.getByRole('button',{name:'Confirm planned leave',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(writes.length,2);await page.locator('.planned-leave .leave-list').waitFor();assert.equal(await page.locator('.planned-leave .leave-list').getByText('Handover prepared. HR approval requested separately.',{exact:true}).count(),1);assert.ok(leaveQueries.some(q=>q.from<=plannedDate&&q.to>=plannedDate),'Saving future leave opens its week');assert.doesNotMatch(await page.locator('body').innerText(),/Invalid Date|NaN/);await capture('timesheet-leave-1440');
 await open('/preview-org/insights?tab=time&s=week&week='+plannedDate,'.planned-leave',390);await page.locator('.planned-leave .leave-list').waitFor();await capture('timesheet-leave-390');
 await open('/preview-org/support','.page-title',390);await page.getByRole('tab',{name:'Tickets',selected:true}).waitFor();assert.ok(/\/work\?tab=tickets$/.test(page.url()),'Old support links land on Work › Tickets');
 assert.equal(await page.getByRole('link',{name:'Support center',exact:true}).count(),0);
 await open('/preview-org/portfolio?project='+pid,'.pp-head h1',1440);assert.equal(await page.getByRole('button',{name:'Ask Agent',exact:true}).count(),0);
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.v2-ask .v2-orb').count(),1,'v2: the Ask bar replaces the animated agent mark');
 // Project cards line up across a row whatever the name, code or description length (the numbers, bar, badges and owner sit at the same height).
 cardProjects=[card(1,'idfc-qr-callback-api','IQCA','Api Configuration and Validation','Mule Soft','AtRisk',1,0,0,'Medium','Integration',owner(1,'Shiva kumar'),'2026-11-13'),
  card(2,'Payment Engine Disaster Recovery (DR) Setup','PEDR','Payment Engine Disaster Recovery (DR) setup in the AWS Hyderabad region, including failover runbooks and quarterly drills.','Mule Soft','AtRisk',1,0,0,'High','NewProject',owner(2,'Prasanna Krishna'),'2026-11-21'),
  card(3,'TCN Call Recording API','TCRA','TCN Call Recording API request implementation, sharing Postman collections with the vendor.','Mule Soft','OnTrack',1,1,100,'Medium','Integration',owner(2,'Prasanna Krishna'),'2026-12-20'),
  card(4,'GEN AI','GA2',null,'Mule Soft','OnTrack',1,1,100,'Medium','NewProject',owner(2,'Prasanna Krishna'),'2027-02-14')];
 await ctx.addInitScript(()=>{try{localStorage.setItem('pm_projects_view','cards');}catch{}});
 await open('/preview-org/projects','.pj2-grid',1440);await page.locator('.pj2-card').nth(3).waitFor();
 for(const width of [1440,1100]){await page.setViewportSize({width,height:1000});await page.waitForTimeout(200);
  // v2: four facts per card, at the same height whatever the name: status, group · owner, one bar, % · due (no boxed numbers, tag row or chat button).
  const cards=await page.evaluate(()=>[...document.querySelectorAll('.pj2-card')].map(c=>({row:Math.round(c.getBoundingClientRect().top),parts:['.pj2-pill','.pj2-sub','.pj2-bar','.pj2-foot'].map(s=>Math.round(c.querySelector(s)?.getBoundingClientRect().top??-1))})));
  assert.equal(await page.locator('.pj2-card .pc-stats, .pj2-card .task-meta, .pj2-card .pchat-btn').count(),0,'no boxed numbers, tag row or chat button');
  for(const row of new Set(cards.map(c=>c.row))){const same=cards.filter(c=>c.row===row);if(same.length<2)continue;
   for(const part of [0,1,2,3]){const tops=same.map(c=>c.parts[part]);assert.ok(Math.max(...tops)-Math.min(...tops)<=1,`project cards misaligned at ${width}px (${['status','group and owner','bar','% and due'][part]}): ${tops.join(', ')}`);}}}
 await page.setViewportSize({width:1440,height:1000});
 await capture('project-cards-1440');
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));await page.waitForTimeout(150);await page.screenshot({path:path.join(out,'project-cards-dark-1440.png'),animations:'disabled'});
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
 for(const width of [820,390]){await page.setViewportSize({width,height:1000});await page.waitForTimeout(200);await capture('project-cards-'+width);}
 cardProjects=null;
 await open('/preview-org/portfolio?project='+pid,'.pp-head h1',1440);await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));await page.waitForTimeout(150);await page.screenshot({path:path.join(out,'project-page-dark-1440.png'),animations:'disabled'});
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,writes:writes.length,errors,scope:'Production bundle with synthetic APIs only; no customer or paid AI actions.'},null,2));console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
