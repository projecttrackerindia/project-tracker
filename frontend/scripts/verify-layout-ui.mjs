import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const origin='https://projecttracker-preview.test',dist=path.resolve('dist'),out=path.resolve('test-results/layout-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Alexandra Montgomery',email:'preview@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:2};
const pid='00000000-0000-0000-0000-000000000003';
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const futureDay=new Date(today+'T00:00:00Z');futureDay.setUTCDate(futureDay.getUTCDate()+8);const plannedDate=futureDay.toISOString().slice(0,10);
const leaveQueries=[];
const project={id:pid,key:'DEMO',name:'Infrastructure delivery',description:'A synthetic project for responsive layout verification.',groupName:'Delivery',status:'Active',health:'OnTrack',progress:33,active:67,startDate:'2026-10-01',dueDate:'2027-07-09',originalDueDate:'2027-07-09',delayedDays:0,projectType:'NewProject',stats:{total:3,done:1,inProgress:2,cancelled:0,todo:0,overdue:0}};
const tasks=[0,1,2].map(i=>({id:`10000000-0000-0000-0000-00000000000${i+1}`,key:`DEMO-${i+1}`,title:['Review integration traffic and verify the approved activity with evidence','Coordinate environment maintenance and record change approval','Prepare deployment access documentation'][i],parentTaskId:null,startDate:'2026-10-05',dueDate:'2026-10-20',originalDueDate:null,delayedDays:0,statusName:i?'In Progress':'Done',statusCategory:i?'InProgress':'Done',statusColor:i?'#7c3aed':'#059669',assignee:{id:user.id,name:user.displayName},overdueDays:0,revisions:0,blockedBy:[]}));
const usage={month:'2026-10',creditsUsed:240,creditsLimit:1000,creditsLeft:740,unlimited:false,maxTier:'deep',attachments:true,actions:true,tiers:[],attachmentTypes:[],maxFiles:3,maxImageMb:2,maxDocumentMb:2};
const errors=[],checks=[],writes=[];let leaves=[];
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
   if(ep.endsWith('/auth/refresh'))data={accessToken:'synthetic-token',expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['org.manage','work.view','work.edit','work.create','reports.view','reports.broad'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3,RESOURCE_MANAGEMENT:1}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/projects'||ep==='/api/v1/work-tasks')data={items:[],page:1,totalPages:0,totalItems:0};
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/workspace/members'))data=[{userId:user.id,displayName:user.displayName,email:user.email,role:'Owner'}];
   else if(ep.endsWith('/project-status/groups'))data=[{id:pid,name:'Delivery',isActive:true,count:1,projects:[project]}];
   else if(ep.includes('/project-status/projects/'))data={project,tasks,changes:[],delayedTasks:0,blockedTasks:0};
   else if(ep==='/api/v1/calendar')data=['Requirements and Planning','Code Review','User Acceptance Testing','Production Deployment'].map((title,i)=>({id:`20000000-0000-0000-0000-00000000000${i}`,type:'stage',title,date:today,status:'Pending',category:'Todo',overdue:false,projectId:pid,projectName:'Long integration project name with a descriptive delivery title',priority:'Medium'}));
   else if(ep==='/api/v1/ai/status')data={enabled:true,configured:true,entitled:true,allowedHere:true,model:'synthetic',provider:'Gemini'};
   else if(ep==='/api/v1/ai/portfolio/brief')data={ranked:[],projects:0,totals:{}};
   else if(ep==='/api/v1/ai/usage')data=usage;
   else if(ep==='/api/v1/ai/usage/report')data={month:'2026-10',creditsUsed:240,creditsLimit:1000,unlimited:false,answers:80,failed:0,byTier:[{tier:'quick',answers:40,credits:40},{tier:'standard',answers:40,credits:200}],people:[{userId:user.id,name:user.displayName,answers:80,credits:240,byTier:[{tier:'quick',answers:40},{tier:'standard',answers:40}]}]};
   else if(ep==='/api/v1/ai/credits/balance')data={spent:240,reserved:20,available:740,unlimited:false};
   else if(ep==='/api/v1/ai/starters')data={greeting:'Welcome',starters:[]};
   else if(ep==='/api/v1/ai/profile')data={detailLevel:0,detailLabel:'Normal length',notes:null,learned:[]};
   else if(ep==='/api/v1/time')data={from:url.searchParams.get('from'),to:url.searchParams.get('to'),user:{id:user.id,name:user.displayName},entries:[],byDay:[],totalMinutes:0,billableMinutes:0};
   else if(ep==='/api/v1/time/leave'){const from=url.searchParams.get('from'),to=url.searchParams.get('to');leaveQueries.push({from,to});data=leaves.filter(l=>l.date>=from&&l.date<=to);}
   else if(ep==='/api/v1/time/approvals')data={pending:[],people:[]};
   else if(ep==='/api/v1/time/week')data={weekStart:url.searchParams.get('weekStart'),weekEnd:today,userId:user.id,totalMinutes:0,billableMinutes:0,status:'NotSubmitted',locked:false,canSubmit:false,canWithdraw:false,canReview:false,entitled:true};
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 let page;
 async function open(url,selector,width){await page?.close();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width,height:1000});await page.goto(origin+url);try{await page.locator(selector).waitFor({timeout:15000});}catch(e){await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({url:page.url(),errors,body:await page.locator('body').innerText()}));throw e;}await page.evaluate(()=>document.fonts.ready);}
 async function capture(name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,name+' viewport overflow');await page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});checks.push(name);}
 for(const width of [1440,1080,820,390]){
  await open('/preview-org/portfolio?project='+pid,'.ps-table',width);
  assert.equal(await page.locator('.ps-head').evaluate(el=>[...el.children].every(c=>c.getBoundingClientRect().right<=el.getBoundingClientRect().right+1)),true,'Project heading stays inside the panel');
  if(width===1080)await page.getByRole('tab',{name:'Side by side'}).click();
  const overlap=await page.locator('.ps-table tbody tr').evaluateAll(rows=>rows.some(row=>{const cells=[...row.cells];return cells.slice(0,-1).some((c,i)=>{const box=c.getBoundingClientRect(),next=cells[i+1].getBoundingClientRect();if(Math.abs(box.top-next.top)>2)return false;return [...c.querySelectorAll('.ps-assignee span:not(.avatar),.ps-date>span,.ps-status')].some(el=>el.getBoundingClientRect().right>box.right+1);});}));
  assert.equal(overlap,false,'Task metadata stays inside its cells');if(width===390)assert.deepEqual(await page.locator('.ps-table tbody tr').first().locator('td').evaluateAll(c=>c.map(t=>t.dataset.label)),['Task','Assignee','Start','Due','Status']);await capture('portfolio-'+width);
 }
 for(const width of [1440,390]){
  await open('/preview-org/calendar','.cal-agenda',width);
  const rows=await page.locator('.cal-agenda .member-item').evaluateAll(items=>items.map(el=>{const badge=el.children[0].getBoundingClientRect(),text=el.children[1].getBoundingClientRect(),row=el.getBoundingClientRect();return badge.right<=text.left+1&&text.right<=row.right+1;}));assert.ok(rows.length===4&&rows.every(Boolean),'Calendar type badges and titles stay in separate lanes');await page.locator('.cal-agenda').scrollIntoViewIfNeeded();await capture('calendar-'+width);
 }
 await open('/preview-org/settings/general','.ai-budgets',1440);
 await page.locator('.ai-budgets').scrollIntoViewIfNeeded();await capture('credit-budgets-1440');
 const person=page.getByRole('combobox',{name:'Person',exact:true});await person.click();await page.getByRole('option',{name:user.displayName,exact:true}).click();await page.getByLabel('Monthly credits').fill('150');await page.getByRole('button',{name:'Save cap',exact:true}).click();await page.waitForTimeout(100);assert.equal(writes.length,1,'Budget saves only reviewed values');
 await open('/preview-org/settings/general','.ai-budgets',390);await page.locator('.ai-budgets').scrollIntoViewIfNeeded();await capture('credit-budgets-390');
 await open('/preview-org/timesheet','.planned-leave',1440);await page.getByRole('button',{name:'Plan leave',exact:true}).click();await page.getByLabel('First day').fill(plannedDate);await page.getByLabel('Last day').fill(plannedDate);await page.getByLabel('Note (optional)').fill('Handover prepared. HR approval requested separately.');await page.getByRole('button',{name:'Review leave',exact:true}).click();assert.equal(writes.length,1,'Review does not write');await page.getByRole('button',{name:'Confirm planned leave',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(writes.length,2);await page.locator('.planned-leave .leave-list').waitFor();assert.equal(await page.locator('.planned-leave .leave-list').getByText('Handover prepared. HR approval requested separately.',{exact:true}).count(),1);assert.ok(leaveQueries.some(q=>q.from<=plannedDate&&q.to>=plannedDate),'Saving future leave opens its week');assert.doesNotMatch(await page.locator('body').innerText(),/Invalid Date|NaN/);await capture('timesheet-leave-1440');
 await open('/preview-org/timesheet?week='+plannedDate,'.planned-leave',390);await page.locator('.planned-leave .leave-list').waitFor();await capture('timesheet-leave-390');
 await open('/preview-org/support','.page-title',390);await page.getByRole('heading',{name:'Operations',exact:true}).waitFor();assert.ok(page.url().endsWith('/operations'),'Old support links redirect to Operations');
 assert.equal(await page.getByRole('link',{name:'Support center',exact:true}).count(),0);
 await open('/preview-org/portfolio?project='+pid,'.ps-table',1440);assert.equal(await page.getByRole('button',{name:'Ask Agent',exact:true}).count(),0);
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.agent-mark.animated .agent-ribbon').first().evaluate(el=>getComputedStyle(el).animationName),'none');
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,writes:writes.length,errors,scope:'Production bundle with synthetic APIs only; no customer or paid AI actions.'},null,2));console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
