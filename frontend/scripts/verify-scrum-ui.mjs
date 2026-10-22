import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';

// Only the built frontend and synthetic API fixtures are used. No live project or AI calls.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/scrum-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Alex Morgan',email:'schedule@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:2};
const pid='00000000-0000-0000-0000-000000000003';
const project={id:pid,key:'DEMO',name:'Connected delivery',description:'A connected timeline with protected history and clear allocations.',status:'Planning',priority:'Medium',health:'OnTrack',progress:0,active:0,startDate:'2030-01-01',dueDate:'2030-01-11',version:5,stageScheduleMode:'FollowSchedule',projectType:'NewProject',deliveryMethod:'Hybrid',owner:{id:user.id,name:user.displayName},stats:{total:0,done:0,inProgress:0,cancelled:0,todo:0,overdue:0}};
const stages=['Created','Design','Build','Launch'].map((name,i)=>({id:`10000000-0000-0000-0000-00000000000${i+1}`,name,order:i,durationDays:[0,4,6,0][i],plannedStart:['2030-01-01','2030-01-01','2030-01-05','2030-01-11'][i],plannedEnd:['2030-01-01','2030-01-05','2030-01-11','2030-01-11'][i],actualStart:i?null:'2029-12-31',actualEnd:i?null:'2029-12-31',status:i?'Pending':'Completed',effectiveStatus:i?'Pending':'Completed',locked:i>1,lockedBy:i>1?['','','Design','Build'][i]:null,taskTotal:0,taskDone:0,openIssues:0,totalIssues:0}));
const detail={project,stages,statuses:[{id:pid,name:'To Do',order:0,category:'Todo',color:'#4f46e5'}],members:[{userId:user.id,name:user.displayName,email:user.email,role:'Owner'}]};
const errors=[],checks=[],saves=[],wsSaves=[],previews=[],stageAttempts=[];
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
  if(ep==='/api/v1/meetings/schedule' && method==='POST'){
    const b=req.postDataJSON();wsSaves.push(b);data={title:b.title,meetUri:'https://meet.google.com/synthetic-team',calendarUrl:null,participantCount:2};
  }else if(ep==='/api/v1/meetings/participants'){data=[{userId:user.id,name:user.displayName,email:user.email,role:'Owner',rsvpStatus:'NeedsAction'},{userId:'00000000-0000-0000-0000-000000000009',name:'Priya Shah',email:'priya@example.test',role:'Member',rsvpStatus:'NeedsAction'}];
  }else if(ep===`/api/v1/projects/${pid}/meetings/schedule` && method==='POST'){
    const b=req.postDataJSON();saves.push(b);data={id:pid,title:b.title,meetUri:'https://meet.google.com/synthetic-call'};
  }else if(ep===`/api/v1/projects/${pid}/meetings/participants`){data=[{userId:user.id,name:user.displayName,email:user.email,role:'Owner',rsvpStatus:'Accepted'}];
  }else if(ep===`/api/v1/projects/${pid}/stages/${stages[1].id}`&&method==='PUT'){
   const b=req.postDataJSON();assert.equal(b.projectVersion,5);assert.equal(b.durationDays,4);assert.equal(b.plannedStart,'2030-01-03');assert.equal(b.plannedEnd,'2030-01-07');assert.equal(b.scheduleReason,null);stageAttempts.push(b);
   await route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({message:'Validation failed',errors:[{field:'dueDateReason',code:'VALIDATION_ERROR',message:'Say why the project end needs to move later.'}]})});return;
  }else if(ep===`/api/v1/projects/${pid}/schedule/preview`){
   const b=req.postDataJSON();previews.push(b);assert.equal(b.version,5);assert.deepEqual(b.durations.map(d=>d.id),stages.map(s=>s.id));
   if(b.mode==='FixedDeadline'&&b.durations[1].durationDays===7){await route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({message:'Validation failed',errors:[{field:'schedule',code:'VALIDATION_ERROR',message:'The schedule finishes on 2030-01-14, 3 day(s) after the project end 2030-01-11. Extend the end date or reduce allocated durations. Nothing was saved.'}]})});return;}
   assert.equal(b.mode,'FollowSchedule');assert.equal(b.durations[1].durationDays,7);assert.equal(b.durations[2].durationDays,6);assert.equal(b.durations[3].durationDays,0);
   data={version:5,mode:'FollowSchedule',startDate:'2030-01-01',dueDate:'2030-01-14',finishDate:'2030-01-14',bufferDays:0,fingerprint:'synthetic-fresh-plan',stages:stages.map((s,i)=>({id:s.id,name:s.name,durationDays:[0,7,6,0][i],start:['2030-01-01','2030-01-01','2030-01-08','2030-01-14'][i],end:['2030-01-01','2030-01-08','2030-01-14','2030-01-14'][i],completed:i===0,changed:i!==0}))};
  }else if(ep===`/api/v1/projects/${pid}/schedule`&&method==='PUT'){
   const b=req.postDataJSON();assert.equal(b.reason,'Approved additional design review');assert.equal(b.expectedFingerprint,'synthetic-fresh-plan');assert.equal(b.durations[1].durationDays,7);saves.push(b);data=detail;
  }else{
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:'synthetic-token',expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','tasks.view','tasks.edit','org.manage','work.view','reports.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3,RESOURCE_MANAGEMENT:1}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep===`/api/v1/projects/${pid}`)data=detail;
   else if(ep.endsWith('/workspace/members'))data=[{userId:user.id,displayName:user.displayName,email:user.email,role:'Owner'}];
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
 for(const width of [1440,390]){
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width,height:1000});
  await page.goto(origin+'/preview-org/calendar');await page.getByRole('button',{name:'Scrum call',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Ask Agent',exact:true}).count(),0,'Header Ask Agent removed');
  // Scrum call opens straight into the form with "No project" as the default: a workspace stand-up needs no project.
  await page.getByRole('button',{name:'Scrum call',exact:true}).click();
  let dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'Schedule scrum call'}).waitFor();
  assert.equal(await dialog.getByLabel('Project',{exact:true}).inputValue(),'','No project is the default');
  assert.equal(await dialog.getByLabel('Title',{exact:true}).inputValue(),'Preview Workspace Scrum');
  await dialog.getByText('Priya Shah',{exact:true}).click();
  await dialog.locator('input[type=date]').fill('2030-01-07');await dialog.locator('input[type=time]').fill('09:30');
  await dialog.getByRole('button',{name:'Send invitation'}).click();await dialog.getByText('Google Meet ready',{exact:true}).waitFor();
  assert.deepEqual(wsSaves.at(-1).participantUserIds,['00000000-0000-0000-0000-000000000009']);assert.equal(wsSaves.at(-1).startTime,'2030-01-07T04:00:00.000Z');
  assert.equal(wsSaves.at(-1).repeat,undefined);checks.push(`scrum-no-project-${width}`);await dialog.getByRole('button',{name:'Done',exact:true}).click();
  // Choosing a project switches the invitees and the suggested title to that project's.
  await page.getByRole('button',{name:'Scrum call',exact:true}).click();
  dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'Schedule scrum call'}).waitFor();
  await dialog.getByLabel('Project',{exact:true}).selectOption(pid);
  assert.equal(await dialog.getByLabel('Title',{exact:true}).inputValue(),'Connected delivery Scrum');
  await dialog.locator('input[type=date]').fill('2030-01-07');await dialog.locator('input[type=time]').fill('09:30');
  await dialog.getByLabel('Repeat',{exact:true}).selectOption('Weekdays');await dialog.getByLabel('Total sessions',{exact:true}).fill('10');
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,`scrum-${width}.png`),animations:'disabled'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'No viewport overflow');assert.deepEqual(await cutOff(page),[],'cut off at the right edge');
  const controls=await dialog.locator('input,select,textarea').evaluateAll(xs=>xs.every(x=>x.getBoundingClientRect().right<=innerWidth+1));assert.ok(controls,'Fields fit viewport');
  await dialog.getByRole('button',{name:'Create series & invite'}).click();await dialog.getByText('Google Meet ready',{exact:true}).waitFor();
  assert.deepEqual(saves.at(-1).repeat,{frequency:'Weekdays',occurrences:10});assert.equal(saves.at(-1).startTime,'2030-01-07T04:00:00.000Z');
  assert.equal(new Date(saves.at(-1).endTime)-new Date(saves.at(-1).startTime),900000);
  checks.push(`scrum-series-${width}`);await dialog.getByRole('button',{name:'Done',exact:true}).click();
  await page.goto(origin+`/preview-org/projects/${pid}`);await page.getByRole('button',{name:'Google Meet',exact:true}).click();await page.getByRole('menuitem',{name:'Schedule scrum call'}).click();
  await page.getByRole('dialog').getByRole('heading',{name:'Schedule scrum call'}).waitFor();checks.push(`project-scrum-${width}`);
  await page.close();
 }
 const logo=await ctx.newPage();await logo.goto(origin+'/preview-org/calendar');await logo.getByRole('button',{name:'Scrum call',exact:true}).waitFor();
 await logo.emulateMedia({reducedMotion:'reduce'});assert.ok(await logo.locator('.agent-ribbon').count());
 assert.ok(await logo.locator('.agent-ribbon').evaluateAll(xs=>xs.every(x=>getComputedStyle(x).animationName==='none')),'Reduced motion disables logo animation');
 await logo.screenshot({path:path.join(out,'header-agent.png'),animations:'disabled'});await logo.close();checks.push('header-and-reduced-motion');
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,saves:saves.length,errors,scope:'Built frontend with synthetic fixtures; no external invitations or AI calls.'},null,2));console.log(JSON.stringify({checks,saves:saves.length,errors}));
}finally{await browser.close();}
