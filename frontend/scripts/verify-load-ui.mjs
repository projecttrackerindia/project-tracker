import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Portfolio › Load (approved designs load-desktop / load-phone): rows most loaded first, a strip coloured by day state, the day detail, the Aura move with Undo, People/Teams/Projects. Older note:: person × week heatmap, Hours/% toggle, the ✦ rebalance card (Preview / Rebalance) and team totals.
// Harness copied from verify-portfolio-ui. Projects › Portfolio (v2; the old /portfolio): the summary (and one written by the AI), decisions with the date change and the other ways
// to recover that become proposals, money with a warning, capacity over 100%, and under ···: filters in the address, the export, the timeline. Synthetic fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/load-v2');
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

// ---- Load fixtures (fictional people only)
const L=['l1','l2','l3','l4','l5'];
const names={l1:'Ravi Kumar',l2:'Meera Rao',l3:'Anita N',l4:'Shiva Kumar',l5:'Siva Reddy'};
const iso=(n)=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+n);const p=(x)=>String(x).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;};
const wd=(n)=>{const d=new Date();d.setDate(d.getDate()+n);return d.getDay()!==0&&d.getDay()!==6;};
const st=(p)=>p==null?'free':p<50?'free':p<=85?'balanced':p<=110?'stretched':'overloaded';
const curve={l1:[60,90,140,150,70,60,75,90,60,50,55,60,50,40],l2:[90,100,70,95,60,60,60,60,55,50,40,45,40,40],l3:[60,65,62,70,55,60,60,60,65,60,55,60,60,60],l4:[25,55,15,10,50,20,25,25,20,30,20,20,20,20],l5:null};
let moved=false;
const row=(id)=>{const c=curve[id];const days=[...Array(14)].map((_,i)=>{const w=wd(i);const leave=id==='l5'&&w&&i<7;const p=!w||leave?null:(id==='l1'&&moved&&i>=2&&i<=3?80:c?c[i]:60);
  return {date:iso(i),workingMinutes:w&&!leave?480:0,meetingMinutes:w?60:0,capacityMinutes:w&&!leave?420:0,committedMinutes:p==null?0:Math.round(p*4.2),percent:p,state:leave?'leave':!w?'off':st(p)};});
 const meta={l1:[moved?'stretched':'overloaded',moved?98:121,'3 tasks due Wed · 9h meetings · 6 in progress'],l2:['stretched',92,'Eases next week'],l3:['balanced',64,'Steady'],l4:['free',28,'~14 free hours'],l5:['leave',null,'Leave Mon–Fri']}[id];
 return {kind:'person',id,name:names[id],state:meta[0],percent:meta[1],reason:meta[2],days,freeMinutes:600,wip:id==='l1'?6:2,signal:null,people:0,freePeople:0,isMe:false};};
const load=(scope)=>{
 if(scope==='teams')return {from:iso(0),days:14,scope,seesOthers:true,mySignal:null,rows:[{...row('l3'),kind:'team',id:'t1',name:'Dev team',reason:'6 people · 1 free · 1 overloaded',people:6,freePeople:1},{...row('l4'),kind:'team',id:'t2',name:'QA team',reason:'4 people · 2 free',people:4,freePeople:2}]};
 if(scope==='projects')return {from:iso(0),days:14,scope,seesOthers:true,mySignal:null,rows:[{...row('l2'),kind:'project',id:'p1',name:'Payments',reason:'3 people · 1 free · 12 open items',people:3,freePeople:1}]};
 return {from:iso(0),days:14,scope:'people',seesOthers:true,mySignal:null,rows:L.map(row)};};
const sugg=()=>moved?[]:[{kind:'task',itemId:'task-cibil',title:'CIBIL mapping',minutes:240,due:iso(3),fromUserId:'l1',fromName:'Ravi Kumar',fromWhen:'Wed–Thu',toUserId:'l4',toName:'Shiva Kumar',toWhen:'Thu',toPercentAfter:60}];
const dayDetail=(u,d)=>({userId:u,name:names[u],date:d,workingMinutes:480,usedMinutes:780,committedMinutes:540,meetingMinutes:240,percent:225,state:'overloaded',
 items:[{kind:'task',id:'task-cibil',title:'CIBIL mapping',projectId:'p1',projectName:'Payments',due:iso(3),minutes:240,dayMinutes:240,basis:'estimate',overdue:false},
  {kind:'task',id:'t2',title:'Payment DR checklist',projectId:'p1',projectName:'Payments',due:iso(2),minutes:180,dayMinutes:180,basis:'size',overdue:false},
  {kind:'action',id:'a1',title:'Release notes',projectId:'p1',projectName:'Payments',due:iso(2),minutes:120,dayMinutes:120,basis:'default',overdue:false}],meetings:[{title:'Stand-up',start:new Date().toISOString(),minutes:240}]});
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
const run=async(theme,shots)=>{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript((t)=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme',t);localStorage.setItem('pm_home_mode','classic');},theme);
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  if(ep==='/api/v1/load/reassign'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});moved=b.toUserId==='l4';data={toUserId:b.toUserId,dryRun:false,items:b.items.map(i=>({...i,title:'CIBIL mapping',fromUserId:b.toUserId==='l4'?'l1':'l4'}))};}
  else if(ep==='/api/v1/load/signal'&&method==='PUT'){writes.push({ep,b:req.postDataJSON()});data={signal:req.postDataJSON().signal};}
  else{
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','tasks.view','org.manage','reports.view','reports.broad','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3,RESOURCE_MANAGEMENT:1}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/load')data=load(url.searchParams.get('scope')||'people');
   else if(ep==='/api/v1/load/suggestions')data=sugg();
   else if(ep.startsWith('/api/v1/load/')&&ep.includes('/day/')){const [,,,,u,,d]=ep.split('/');data=dayDetail(u,d);}
   else if(ep==='/api/v1/portfolio/board')data=board();
   else if(ep==='/api/v1/portfolio/timeline')data=timeline;
   else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
   else if(ep==='/api/v1/saved-views')data=[];
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
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(350);await page.screenshot({path:path.join(out,name),fullPage:false});};
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 try{
  moved=false;
  for(const w of [1440,1920]){
   await page.setViewportSize({width:w,height:w===1920?1080:960});
   await page.goto(origin+'/preview-org/work/projects?view=portfolio&mode=capacity');
   const ld=page.getByRole('region',{name:'Load'});await ld.waitFor();
   await page.getByText('Ravi Kumar').first().waitFor();
   assert.ok(await page.getByRole('tablist',{name:'Portfolio view'}).getByRole('tab',{name:'Load',selected:true}).isVisible(),'the tab is called Load');
   const rows=ld.getByRole('table').getByRole('row');
   assert.equal(await rows.count(),5);
   assert.match(await rows.first().innerText(),/Ravi Kumar[\s\S]*Overloaded/);
   assert.match(await rows.last().innerText(),/Siva Reddy[\s\S]*On leave/);
   assert.equal(await rows.first().locator('.ld-bar').count(),12,'12-day strip on desktop');
   assert.ok(await ld.getByText('Rebalance this week').isVisible());
   assert.ok(await ld.getByText(/Move “CIBIL mapping” \(4h\) from Ravi to Shiva/).isVisible());
   await ld.getByText('13h of 8h').waitFor();
   assert.ok(await ld.getByText(/How it’s worked out/).isVisible());
   await shot(page,`load-${w}-${theme}.png`);
  }
  checks.push(`desktop-${theme}`);
  if(shots==='full'){
   // A day click opens what fills it; Move it, then Undo.
   await page.setViewportSize({width:1440,height:960});
   const ld=page.getByRole('region',{name:'Load'});
   await ld.getByRole('table').getByRole('row').nth(1).locator('button.ld-bar').first().click();
   await ld.getByText(/^Meera · /).waitFor();
   await ld.getByRole('button',{name:'Move it'}).click();
   for(let i=0;i<30&&!writes.some(w=>w.ep==='/api/v1/load/reassign');i++)await page.waitForTimeout(100);
   assert.deepEqual(writes.find(w=>w.ep==='/api/v1/load/reassign').b,{toUserId:'l4',items:[{kind:'task',id:'task-cibil'}]});
   await page.getByRole('button',{name:'Undo'}).click();
   for(let i=0;i<30&&writes.filter(w=>w.ep==='/api/v1/load/reassign').length<2;i++)await page.waitForTimeout(100);
   assert.equal(writes.filter(w=>w.ep==='/api/v1/load/reassign')[1].b.toUserId,'l1','undo moves it back');
   checks.push('move+undo');
   moved=false;
   for(const sc of ['Teams','Projects']){await ld.getByRole('tablist',{name:'Load by'}).getByRole('tab',{name:sc}).click();await ld.getByRole('table').getByRole('row').first().waitFor();await page.waitForTimeout(250);await shot(page,`load-${sc.toLowerCase()}-1440-${theme}.png`);}
   assert.match(await ld.getByRole('table').innerText(),/Payments/);
   await ld.getByRole('tablist',{name:'Load by'}).getByRole('tab',{name:'People'}).click();
   checks.push('scopes');
  }
  // Phone
  await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/preview-org/work/projects?view=portfolio&mode=capacity');
  const ld=page.getByRole('region',{name:'Load'});await ld.waitFor();await page.getByText('Ravi Kumar').first().waitFor();
  assert.ok(await ld.getByRole('button',{name:'Move “CIBIL mapping” to Shiva'}).isVisible());
  assert.equal(await ld.locator('.ld-pc').first().locator('.ld-bar').count(),10,'10 days with letters on the phone');
  await fitsPhone(page,`load phone ${theme}`,assert);
  await shot(page,`load-390-${theme}.png`);
  await page.screenshot({path:path.join(out,`load-390-${theme}-full.png`),fullPage:true});
  await ld.locator('.ld-pc').first().locator('button.ld-bar').nth(2).click();
  await page.getByRole('dialog').getByText('13h of 8h').waitFor();
  await shot(page,`load-day-390-${theme}.png`);
  checks.push(`phone-${theme}`);
  assert.deepEqual(errors,[]);
 }catch(e){await page.screenshot({path:path.join(out,`failure-${theme}.png`),fullPage:true}).catch(()=>{});console.log('URL:',page.url());console.log('errors:',errors);throw e;}
 await ctx.close();
};
try{await run('light','full');await run('dark','basic');console.log('load ui ok:',checks.join(', '));}finally{await browser.close();}
