import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';

// The timesheet: the week grid (typing, keyboard, notes, rows, quick add, copy, export), Insights, Entries, bulk approval and the phone
// day view. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/timesheet-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const pid='00000000-0000-0000-0000-000000000003';
const iso=(d)=>d.toISOString().slice(0,10);
const add=(s,n)=>{const d=new Date(`${s}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return iso(d);};
const today=iso(new Date(Date.now()+330*60000));
const dow=(new Date(`${today}T00:00:00Z`).getUTCDay()+6)%7;
const thisMonday=add(today,-dow), week=add(thisMonday,-7);
const dates=[0,1,2,3,4,5,6].map(i=>add(week,i));

// ---- a tiny timesheet server
const rows=[
 {kind:'task',targetId:'t1',key:'PAY-12',title:'Gateway integration',projectId:pid,projectName:'Payments Core',billable:true,m:{[dates[0]]:240,[dates[1]]:180},notes:{[dates[0]]:'Webhook retries'}},
 {kind:'work',targetId:'w1',key:'WT-4',title:'Vendor escalations',projectId:null,projectName:null,billable:false,m:{[dates[1]]:60,[dates[2]]:120},notes:{}},
];
const suggestions=[
 {kind:'task',targetId:'t2',key:'PAY-14',title:'Bank certification',projectId:pid,projectName:'Payments Core',reason:'lastWeek'},
 {kind:'task',targetId:'t3',key:'PAY-18',title:'Go live checklist',projectId:pid,projectName:'Payments Core',reason:'assigned'},
 {kind:'work',targetId:'w2',key:'WT-9',title:'Access requests',projectId:null,projectName:null,reason:'touched'},
];
const known={t2:suggestions[0],t3:suggestions[1],w2:suggestions[2],t9:{kind:'task',targetId:'t9',key:'PAY-21',title:'Refund flow',projectId:pid,projectName:'Payments Core'}};
// What the server reads from plain words (the real reading is covered by the API tests).
const T={pay12:{kind:'task',targetId:'t1',key:'PAY-12',title:'Gateway integration',projectName:'Payments Core'},standup:{kind:'work',targetId:'w3',key:'WT-11',title:'Daily standup',projectName:null},
 wt4:{kind:'work',targetId:'w1',key:'WT-4',title:'Vendor escalations',projectName:null},pay14:{kind:'task',targetId:'t2',key:'PAY-14',title:'Bank certification',projectName:'Payments Core'}};
const yesterday=add(today,-1);
function words(text){
 if(text==='ninna')return {text:'నిన్న 2 గంటలు PAY-12',entries:[{text:'నిన్న 2 గంటలు PAY-12',minutes:120,date:yesterday,target:T.pay12,note:null,match:'ai',options:[T.pay12,T.wt4],problem:null}],dayMinutes:480,usedAi:true,model:'test',transcript:null,language:null};
 return {text,dayMinutes:480,usedAi:false,model:null,transcript:null,language:null,entries:[
  {text:'2h on PAY-12 yesterday',minutes:120,date:yesterday,target:T.pay12,note:null,match:'key',options:[T.pay12,T.wt4,T.pay14],problem:null},
  {text:'30m standup',minutes:30,date:yesterday,target:T.standup,note:'standup',match:'title',options:[T.standup,T.pay12,T.wt4],problem:null},
  {text:'45m on XYZ-9',minutes:45,date:yesterday,target:null,note:null,match:'none',options:[T.pay12,T.wt4,T.pay14],problem:'There is no XYZ-9 that you can see.'}]};
}
const leaveDay=dates[3];
function grid(){
 const days=dates.map((d,i)=>{const minutes=rows.reduce((n,r)=>n+(r.m[d]??0),0);const weekend=i>=5,leave=d===leaveDay;
  return {date:d,minutes,targetMinutes:weekend||leave?0:480,weekend,leave,leaveNote:leave?'Family function':null,future:d>today,meetings:i===0?2:i===2?1:0,meetingMinutes:i===0?75:i===2?30:0};});
 const gr=rows.map(r=>({kind:r.kind,targetId:r.targetId,key:r.key,title:r.title,projectId:r.projectId,projectName:r.projectName,billable:r.billable,
  cells:dates.map(d=>({date:d,minutes:r.m[d]??0,entries:r.m[d]?1:0,running:false,note:r.notes[d]??null})),totalMinutes:dates.reduce((n,d)=>n+(r.m[d]??0),0)}));
 const total=days.reduce((n,d)=>n+d.minutes,0),target=days.reduce((n,d)=>n+d.targetMinutes,0);
 return {weekStart:week,weekEnd:dates[6],user:{id:user.id,name:user.displayName},mine:true,editable:true,locked:false,status:'NotSubmitted',days,rows:gr,
  suggestions:suggestions.filter(s=>!rows.some(r=>r.targetId===s.targetId)),totalMinutes:total,billableMinutes:gr.filter(r=>r.billable).reduce((n,r)=>n+r.totalMinutes,0),
  targetMinutes:target,overtimeMinutes:days.reduce((n,d)=>n+Math.max(0,d.minutes-d.targetMinutes),0),missingDays:days.filter(d=>d.targetMinutes>0&&d.minutes===0&&d.date<today).length,running:null};
}
function apply(cells){
 for(const c of cells){let r=rows.find(x=>x.kind===c.kind&&x.targetId===c.targetId);
  if(!r){const k=known[c.targetId];r={...k,billable:false,m:{},notes:{}};rows.push(r);}
  if(c.minutes>0)r.m[c.date]=c.minutes;else delete r.m[c.date];
  if(c.note!=null)r.notes[c.date]=c.note;}
}
const insights={user:{id:user.id,name:user.displayName},from:add(thisMonday,-49),to:add(thisMonday,6),
 weeks:[7,6,5,4,3,2,1,0].map(i=>({weekStart:add(thisMonday,-7*i),loggedMinutes:[2280,2460,2400,1980,2520,2700,2160,600][7-i],billableMinutes:[1500,1620,1700,1200,1800,1900,1400,300][7-i],targetMinutes:i===0?Math.min(5,dow+1)*480:i===3?1920:2400,overtimeMinutes:[0,60,0,0,120,300,0,0][7-i],leaveDays:i===3?1:0,missingDays:i===1?1:0,status:i>=2?'Approved':i===1?'Submitted':'NotSubmitted'})),
 byProject:[{label:'Payments Core',projectId:pid,minutes:9600},{label:'Operational work',projectId:null,minutes:4200},{label:'Mobile Banking',projectId:'p2',minutes:3300},{label:'Data Platform',projectId:'p3',minutes:1000}],
 byWeekday:[0,1,2,3,4,5,6].map(i=>({day:i,averageMinutes:[470,500,455,430,390,40,0][i]})),
 loggedMinutes:17100,billableMinutes:11420,targetMinutes:18240,overtimeMinutes:480,utilisation:0.9375,billableShare:0.6678,sameDayShare:0.82,streak:6,missingDays:[add(week,4)]};
const approvals={weekStart:week,entitled:true,week:[
 {id:'a1',user:{id:'u2',name:'Upendra Rao'},weekStart:week,status:'Submitted',totalMinutes:2460,billableMinutes:1800,note:'Thursday half day',submittedAt:new Date(Date.now()-7200e3).toISOString(),reviewer:null,reviewedAt:null,reviewNote:null},
 {id:'a2',user:{id:'u3',name:'Jyothsna Reddy'},weekStart:week,status:'Submitted',totalMinutes:2400,billableMinutes:2100,note:null,submittedAt:new Date(Date.now()-3600e3).toISOString(),reviewer:null,reviewedAt:null,reviewNote:null},
 {id:'a3',user:{id:'u4',name:'Ravi Kumar'},weekStart:week,status:'Submitted',totalMinutes:1980,billableMinutes:900,note:null,submittedAt:new Date(Date.now()-600e3).toISOString(),reviewer:null,reviewedAt:null,reviewNote:null},
 {id:null,user:{id:'u5',name:'Meera Iyer'},weekStart:week,status:'NotSubmitted',totalMinutes:720,billableMinutes:0,note:null,submittedAt:null,reviewer:null,reviewedAt:null,reviewNote:null}],pending:[]};
approvals.pending=approvals.week.filter(r=>r.status==='Submitted');
const entries=rows.flatMap(r=>Object.entries(r.m).map(([d,m],i)=>({id:`${r.targetId}-${i}`,taskId:r.kind==='task'?r.targetId:null,taskKey:r.key,taskTitle:r.title,projectId:r.projectId,user:{id:user.id,name:user.displayName},workDate:d,minutes:m,note:r.notes[d]??null,isRunning:false,startedAt:null,canEdit:true,workTaskId:r.kind==='work'?r.targetId:null,kind:r.kind,billable:r.billable,locked:false})));

const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true,
 args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
try{
 const make=async(theme='light')=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block',acceptDownloads:true,permissions:['microphone']});
  await ctx.addInitScript((t)=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme',t);},theme);
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[];
   if(ep==='/api/v1/time/grid'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});apply(b.cells);data={grid:grid(),saved:b.cells.length,errors:[]};}
   else if(ep==='/api/v1/time/grid/draft'){data={weekStart:week,cells:[
     {kind:'task',targetId:'t1',key:'PAY-12',title:'Gateway integration',projectName:'Payments',date:dates[3],minutes:360,why:'3 changes or comments by you that day · 8 h working day'},
     {kind:'task',targetId:'t2',key:'PAY-14',title:'Refund API',projectName:'Payments',date:dates[3],minutes:120,why:'1 change or comment by you that day · 8 h working day'}],
     days:dates.map((d,i)=>({date:d,availableMinutes:i===3?480:0,meetingMinutes:0,skipped:i===3?null:i>4?'Weekend':'Already logged'}))};}
   else if(ep==='/api/v1/time/grid/copy-previous'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});apply([{kind:'task',targetId:'t1',date:dates[2],minutes:180},{kind:'task',targetId:'t1',date:dates[4],minutes:120}]);data={grid:grid(),saved:2,errors:[]};}
   else if(ep==='/api/v1/time/words'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data=words(b.text);}
   else if(ep==='/api/v1/time/words/voice'&&method==='POST'){writes.push({ep,b:null});data={...words('ninna'),transcript:'నిన్న 2 గంటలు PAY-12',language:'te',usedAi:true,model:'test'};}
   else if(ep==='/api/v1/time/words/log'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});
     // A day in a submitted week cannot take time: the server says so per entry and logs the rest.
     const bad=b.entries.filter(e=>e.date===dates[0]),ok=b.entries.filter(e=>e.date!==dates[0]);
     data={saved:ok.length,minutes:ok.reduce((n,e)=>n+e.minutes,0),entries:[],errors:bad.map(e=>({kind:e.kind,targetId:e.targetId,date:e.date,message:'This week is submitted, so its time cannot change.'}))};}
   else if(ep==='/api/v1/time/approvals/approve'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={approved:b.ids.length,failed:[]};}
   else if(ep==='/api/v1/agent/inbox')data={items:[],pending:0,canDecide:true};
   else if(ep==='/api/v1/agent/assigned')data={items:[],pending:0,canDecide:false};
   else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,reportCount:4,permissions:['projects.view','projects.edit','tasks.view','tasks.edit','org.manage','reports.view','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3,RESOURCE_MANAGEMENT:1}}};
    else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
    else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
    else if(ep==='/api/v1/time/grid')data=grid();
    else if(ep==='/api/v1/time/insights')data=insights;
    else if(ep==='/api/v1/time/approvals')data=approvals;
    else if(ep==='/api/v1/time/week')data={weekStart:week,weekEnd:dates[6],userId:user.id,status:'NotSubmitted',totalMinutes:grid().totalMinutes,billableMinutes:grid().billableMinutes,note:null,submittedAt:null,reviewer:null,reviewedAt:null,reviewNote:null,locked:false,canSubmit:true,canWithdraw:false,canReview:false,id:null,entitled:true};
    else if(ep==='/api/v1/time')data={from:url.searchParams.get('from'),to:url.searchParams.get('to'),user:{id:user.id,name:user.displayName},entries,totalMinutes:entries.reduce((n,e)=>n+e.minutes,0),byDay:dates.map(d=>({date:d,minutes:entries.filter(e=>e.workDate===d).reduce((n,e)=>n+e.minutes,0)})),billableMinutes:0};
    else if(ep==='/api/v1/search')data={hits:[{type:'task',id:'t9',title:'Refund flow',subtitle:'PAY-21 · In Progress',projectId:pid,taskId:'t9'}]};
    else if(ep==='/api/v1/time/leave')data=[];
    else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
    else if(ep==='/api/v1/timer')data=null;
    else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
    else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
    else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
    else if(ep==='/api/v1/chat/projects/unread')data=[];
    else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
    else if(ep==='/api/v1/workspace/members')data=[];
   }
   await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
  });
  return ctx;};
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(500);await page.screenshot({path:path.join(out,name)});};
 const cell=(page,r,c)=>page.locator(`.tsg-table input[data-r="${r}"][data-c="${c}"]`);
 const lastPut=async(n)=>{for(let i=0;i<40&&writes.filter(w=>w.ep==='/api/v1/time/grid').length<n;i++)await new Promise(r=>setTimeout(r,100));return writes.filter(w=>w.ep==='/api/v1/time/grid').at(-1);};
 const puts=()=>writes.filter(w=>w.ep==='/api/v1/time/grid').length;

 let ctx=await make();let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(`${origin}/preview-org/timesheet?week=${week}`);await page.locator('.tsg-table').waitFor();
 assert.equal(await page.locator('.tsg-table tbody tr').count(),2);
 assert.equal(await page.locator('.tsg-day').count(),7);
 assert.ok(await page.locator('.tsg-day.leave .tsg-tag.leave').isVisible());
 assert.ok(await page.locator('.tsg-tag.meet').first().isVisible());
 assert.equal(await cell(page,0,0).inputValue(),'4:00');
 assert.ok((await page.locator('.tsg-hero').innerText()).toLowerCase().includes('logged'));
 const tabs=await page.locator('.route-tabs .tab').allInnerTexts();
 assert.ok(['Week','Insights','Entries'].every(t=>tabs.some(x=>x.startsWith(t)))&&tabs.some(x=>x.startsWith('Approvals')),`tabs: ${tabs}`);
 checks.push('grid-renders');
 await shot(page,'week-1440.png');

 // Typing a total: "1.5" is an hour and a half; Enter moves down.
 await cell(page,0,2).click();await page.keyboard.type('1.5');await page.keyboard.press('Enter');
 let w=await lastPut(1);
 assert.deepEqual(w.b.cells.map(c=>[c.targetId,c.date,c.minutes]),[['t1',dates[2],90]]);
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-r')),'1');
 checks.push('type-enter-moves');
 // The arrow keys move along the week; 1:30 and 45m are understood too.
 await cell(page,1,3).fill('45m');await page.keyboard.press('ArrowUp');
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-r')),'0');
 await page.keyboard.type('1:30');await page.keyboard.press('ArrowRight');
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-c')),'4');
 w=await lastPut(2);
 const sent=writes.filter(x=>x.ep==='/api/v1/time/grid').slice(1).flatMap(x=>x.b.cells).map(c=>[c.targetId,c.date,c.minutes]);
 assert.ok(sent.some(c=>c[0]==='w1'&&c[1]===dates[3]&&c[2]===45)&&sent.some(c=>c[0]==='t1'&&c[1]===dates[3]&&c[2]===90),JSON.stringify(sent));
 checks.push('keyboard-and-formats');
 // Escape undoes the cell; something it cannot read is flagged and never sent.
 const before=puts();
 await cell(page,0,5).click();await page.keyboard.type('3');await page.keyboard.press('Escape');
 assert.equal(await cell(page,0,5).inputValue(),'');
 await page.keyboard.type('lots');await page.keyboard.press('Enter');await page.waitForTimeout(1000);
 assert.equal(puts(),before);assert.ok(await page.locator('.tsg-cell.bad').count()>=1);
 await cell(page,0,5).fill('');await page.keyboard.press('Tab');await page.waitForTimeout(900);
 checks.push('escape-and-invalid');

 // A note for one day.
 await cell(page,1,2).click();
 await page.locator('#tsg-note').fill('Escalated to the vendor');await page.getByRole('button',{name:'Save note'}).click();
 w=await lastPut(puts()+1);
 assert.equal(w.b.cells[0].note,'Escalated to the vendor');
 checks.push('note');

 // Rows: a suggestion, and search.
 await page.getByRole('button',{name:'Add row'}).click();
 await page.locator('.tsg-sug',{hasText:'PAY-14'}).click();
 assert.equal(await page.locator('.tsg-table tbody tr').count(),3);
 await page.locator('.tsg-search input').fill('refund');await page.locator('.tsg-hit',{hasText:'PAY-21'}).click();
 assert.equal(await page.locator('.tsg-table tbody tr').count(),4);
 await shot(page,'add-rows-1440.png');
 await cell(page,2,0).fill('2');await page.keyboard.press('Enter');
 w=await lastPut(puts()+1);
 assert.deepEqual(w.b.cells.map(c=>[c.kind,c.targetId,c.minutes]),[['task','t2',120]]);
 checks.push('add-rows');

 // Quick add: "45m WT-4 tue standup" adds to Tuesday's cell.
 const tue=rows.find(r=>r.targetId==='w1').m[dates[1]]??0;
 await page.locator('.tsg-quick input').fill('45m WT-4 tue standup');await page.getByRole('button',{name:'Add',exact:true}).click();
 w=await lastPut(puts()+1);
 assert.deepEqual(w.b.cells.map(c=>[c.targetId,c.date,c.minutes,c.note]),[['w1',dates[1],tue+45,'standup']]);
 // Today is not in the week on screen, so the server reads it and it is shown for checking instead.
 await page.locator('.tsg-quick input').fill('2h PAY-12');await page.getByRole('button',{name:'Add',exact:true}).click();
 await page.getByRole('dialog',{name:'Check your time'}).waitFor();assert.equal(writes.at(-1).ep,'/api/v1/time/words');
 await page.getByRole('dialog',{name:'Check your time'}).getByRole('button',{name:'Cancel'}).click();await page.getByRole('dialog',{name:'Check your time'}).waitFor({state:'detached'});
 checks.push('quick-add');

 // Plain words: several pieces are read on the server and shown for checking; nothing is logged until "Add".
 await page.locator('.tsg-quick input').fill('2h on PAY-12 yesterday, 30m standup, 45m on XYZ-9');await page.getByRole('button',{name:'Add',exact:true}).click();
 const tw=page.getByRole('dialog',{name:'Check your time'});await tw.locator('.tw-row').nth(2).waitFor();
 assert.equal(writes.at(-1).ep,'/api/v1/time/words');assert.equal(writes.at(-1).b.text,'2h on PAY-12 yesterday, 30m standup, 45m on XYZ-9');
 assert.equal(await tw.locator('.tw-row').count(),3);
 assert.ok(await tw.locator('.tw-row').nth(2).evaluate(el=>el.classList.contains('off')),'a piece without its work starts unticked');
 assert.match(await tw.getByRole('button',{name:/^Add \d/}).innerText(),/Add 2 entries · 2h 30m/);
 assert.match(await tw.locator('.tw-row').nth(0).innerText(),/By its key/);assert.match(await tw.locator('.tw-row').nth(1).innerText(),/From the words/);
 await shot(page,'words-review-1440.png');
 // Choose the work for the third, change its time and day, add a note; then send.
 await tw.getByRole('combobox',{name:'Work for “45m on XYZ-9”'}).click();await page.getByRole('option',{name:/WT-4 · Vendor escalations/}).click();
 assert.ok(await tw.locator('.tw-row').nth(2).locator('input[type=checkbox]').isChecked(),'choosing the work ticks it');
 await tw.getByLabel('How long for “45m on XYZ-9”').fill('1h');await tw.getByLabel('Note for “45m on XYZ-9”').fill('Vendor call');
 await tw.getByLabel('Day for “45m on XYZ-9”').fill(dates[2]);
 // A day still to come is caught before sending.
 await tw.getByLabel('Day for “30m standup”').fill(add(today,2));
 assert.match(await tw.locator('.tw-row').nth(1).innerText(),/not happened yet/);
 assert.match(await tw.getByRole('button',{name:/^Add \d/}).innerText(),/Add 2 entries · 3h/);
 await tw.getByLabel('Day for “30m standup”').fill(yesterday);
 // Search for other work from the list.
 await tw.getByRole('combobox',{name:'Work for “2h on PAY-12 yesterday”'}).click();await page.getByRole('option',{name:'Search for other work…'}).click();
 await tw.getByLabel('Search work').fill('refund');await tw.locator('.tw-hits button',{hasText:'PAY-21'}).click();
 assert.match(await tw.getByRole('combobox',{name:'Work for “2h on PAY-12 yesterday”'}).innerText(),/PAY-21/);
 await tw.getByRole('button',{name:/^Add 3 entries · 3h 30m/}).click();await tw.waitFor({state:'detached'});
 const lw=writes.filter(x=>x.ep==='/api/v1/time/words/log').at(-1).b.entries;
 assert.deepEqual(lw.map(e=>[e.kind,e.targetId,e.date,e.minutes,e.note]),[['task','t9',yesterday,120,null],['work','w3',yesterday,30,'standup'],['work','w1',dates[2],60,'Vendor call']]);
 checks.push('plain-words');

 // An entry the server refuses stays in the list with its reason; the rest are logged.
 await page.locator('.tsg-quick input').fill('2h on PAY-12 yesterday, 30m standup, 45m on XYZ-9');await page.getByRole('button',{name:'Add',exact:true}).click();
 await tw.locator('.tw-row').nth(2).waitFor();await tw.getByRole('button',{name:'Remove “45m on XYZ-9”'}).click();
 assert.equal(await tw.locator('.tw-row').count(),2);
 await tw.getByLabel('Day for “30m standup”').fill(dates[0]);
 await tw.getByRole('button',{name:/^Add 2 entries/}).click();
 await tw.locator('.tw-row.bad').waitFor();
 assert.equal(await tw.locator('.tw-row').count(),1);
 assert.match(await tw.locator('.tw-row').innerText(),/submitted, so its time cannot change/);
 await shot(page,'words-refused-1440.png');
 await tw.getByRole('button',{name:'Cancel'}).click();await tw.waitFor({state:'detached'});
 checks.push('plain-words-fix');

 // Copy last week, and export.
 await page.getByRole('button',{name:'Copy last week'}).click();
 for(let i=0;i<30&&!writes.some(x=>x.ep.endsWith('copy-previous'));i++)await page.waitForTimeout(100);
 assert.equal(writes.find(x=>x.ep.endsWith('copy-previous')).b.weekStart,week);
 const dl=page.waitForEvent('download');await page.getByRole('button',{name:'Export'}).click();const file=await dl;
 assert.ok(file.suggestedFilename().endsWith(`${week}.csv`));
 const csv=await fs.readFile(await file.path(),'utf8');assert.ok(csv.includes('PAY-12')&&csv.includes('Gateway integration'),csv);
 checks.push('copy-export');
 // Draft my week: proposals with reasons, untick one, add the rest through the ordinary save.
 await page.getByRole('button',{name:'Draft my week'}).click();const dw=page.getByRole('dialog',{name:'Draft my week'});await dw.locator('.twd-row').nth(1).waitFor();
 assert.match(await dw.innerText(),/3 changes or comments by you that day/);await shot(page,'draft-week-1440.png');
 const beforeDraft=puts();await dw.locator('.twd-row',{hasText:'Refund API'}).locator('input').uncheck();
 await dw.getByRole('button',{name:/Add 1 entry/}).click();const dput=await lastPut(beforeDraft+1);
 assert.deepEqual(dput.b.cells.map(c=>[c.targetId,c.date,c.minutes]),[['t1',dates[3],360]]);await dw.waitFor({state:'detached'});checks.push('draft-week');
 await shot(page,'week-after-1440.png');

 // Insights.
 await page.locator('.route-tabs .tab',{hasText:'Insights'}).click();await page.locator('.tsi-kpis').waitFor();
 assert.ok((await page.locator('.tsi-kpis').innerText()).includes('94%'));
 assert.equal(await page.locator('.tsi-shares li').count(),4);
 assert.ok(await page.locator('.tsi .recharts-surface').count()>=2);
 await shot(page,'insights-1440.png');
 await page.locator('.tsi-week').nth(1).click();await page.locator('.tsg-table').waitFor();
 assert.ok(page.url().includes('/timesheet?week='));
 checks.push('insights');

 // Entries, then approvals: pick two weeks and approve them together.
 await page.locator('.route-tabs .tab',{hasText:'Entries'}).click();await page.locator('.time-list').waitFor();
 checks.push('entries');
 await page.locator('.route-tabs .tab',{hasText:'Approvals'}).click();await page.locator('.ts-table').first().waitFor();
 await page.getByLabel("Select Upendra Rao's week").check();await page.getByLabel("Select Ravi Kumar's week").check();
 await page.getByRole('button',{name:'Approve 2 selected'}).click();
 for(let i=0;i<30&&!writes.some(x=>x.ep.endsWith('/approvals/approve'));i++)await page.waitForTimeout(100);
 assert.deepEqual(writes.find(x=>x.ep.endsWith('/approvals/approve')).b.ids,['a1','a3']);
 await shot(page,'approvals-1440.png');
 checks.push('bulk-approve');
 await page.close();await ctx.close();

 // Dark.
 ctx=await make('dark');page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(`${origin}/preview-org/timesheet?week=${week}`);await page.locator('.tsg-table').waitFor();await shot(page,'week-dark-1440.png');
 await page.goto(`${origin}/preview-org/timesheet/insights`);await page.locator('.tsi-kpis').waitFor();await shot(page,'insights-dark-1440.png');
 checks.push('dark');
 await page.close();await ctx.close();

 // Phone: one day at a time, with steppers; nothing scrolls sideways.
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
 await page.goto(`${origin}/preview-org/timesheet?week=${week}`);await page.locator('.tsd').waitFor();
 assert.equal(await page.locator('.tsd-day').count(),7);
 await shot(page,'phone-top-390.png');
 await page.locator('.tsd-day').first().click();
 const mon=rows.find(r=>r.targetId==='t1').m[dates[0]]??0;
 await page.getByRole('button',{name:'15 minutes more on PAY-12'}).click();
 w=await lastPut(puts()+1);
 assert.deepEqual(w.b.cells.map(c=>[c.targetId,c.date,c.minutes]),[['t1',dates[0],mon+15]]);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(await cutOff(page),[],'cut off at the right edge');
 await shot(page,'phone-390.png');
 await page.goto(`${origin}/preview-org/timesheet/insights`);await page.locator('.tsi-kpis').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(await cutOff(page),[],'cut off at the right edge');
 await shot(page,'insights-390.png');
 checks.push('phone-day-view');

 // Phone: plain words and a voice note, checked in a sheet that fits the screen.
 await page.goto(`${origin}/preview-org/timesheet?week=${week}`);await page.locator('.tsd').waitFor();
 await page.locator('.tsg-quick input').fill('2h on PAY-12 yesterday, 30m standup, 45m on XYZ-9');await page.getByRole('button',{name:'Add',exact:true}).click();
 const ptw=page.getByRole('dialog',{name:'Check your time'});await ptw.locator('.tw-row').nth(2).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(await cutOff(page),[],'cut off at the right edge');
 const box=await ptw.locator('.tw-row').first().boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390,'a row fits the phone');
 await shot(page,'words-review-390.png');
 await ptw.getByRole('button',{name:'Cancel'}).click();await ptw.waitFor({state:'detached'});
 await page.getByRole('button',{name:'Say it instead'}).click();await page.locator('.tsg-rec',{hasText:'Listening'}).waitFor();
 await shot(page,'words-listening-390.png');
 await page.waitForTimeout(1300);await page.getByRole('button',{name:'Done'}).click();
 await ptw.locator('.tw-heard',{hasText:'నిన్న 2 గంటలు PAY-12'}).waitFor();assert.match(await ptw.locator('.tw-heard').innerText(),/Read with AI/);
 assert.ok(writes.some(x=>x.ep==='/api/v1/time/words/voice'));
 await shot(page,'words-voice-390.png');
 await ptw.getByRole('button',{name:/^Add 1 entry · 2h/}).click();await ptw.waitFor({state:'detached'});
 assert.deepEqual(writes.filter(x=>x.ep==='/api/v1/time/words/log').at(-1).b.entries.map(e=>[e.targetId,e.date,e.minutes]),[['t1',yesterday,120]]);
 checks.push('phone-plain-words','phone-voice');
 await page.close();await ctx.close();

 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,writes:writes.length,errors},null,2));
 console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
