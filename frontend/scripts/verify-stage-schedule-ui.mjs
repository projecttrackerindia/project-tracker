import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';

// Only the built frontend and synthetic API fixtures are used. No live project or AI calls.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/stage-schedule-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Alex Morgan',email:'schedule@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:2};
const pid='00000000-0000-0000-0000-000000000003';
const project={id:pid,key:'DEMO',name:'Connected delivery',description:'A connected timeline with protected history and clear allocations.',status:'Planning',priority:'Medium',health:'OnTrack',progress:0,active:0,startDate:'2030-01-01',dueDate:'2030-01-11',version:5,stageScheduleMode:'FollowSchedule',projectType:'NewProject',deliveryMethod:'Hybrid',owner:{id:user.id,name:user.displayName},stats:{total:0,done:0,inProgress:0,cancelled:0,todo:0,overdue:0}};
const stages=['Created','Design','Build','Launch'].map((name,i)=>({id:`10000000-0000-0000-0000-00000000000${i+1}`,name,order:i,durationDays:[0,4,6,0][i],plannedStart:['2030-01-01','2030-01-01','2030-01-05','2030-01-11'][i],plannedEnd:['2030-01-01','2030-01-05','2030-01-11','2030-01-11'][i],actualStart:i?null:'2029-12-31',actualEnd:i?null:'2029-12-31',status:i?'Pending':'Completed',effectiveStatus:i?'Pending':'Completed',locked:i>1,lockedBy:i>1?['','','Design','Build'][i]:null,taskTotal:0,taskDone:0,openIssues:0,totalIssues:0}));
const detail={project,stages,statuses:[{id:pid,name:'To Do',order:0,category:'Todo',color:'#4f46e5'}],members:[{userId:user.id,name:user.displayName,email:user.email,role:'Owner'}]};
const errors=[],checks=[],saves=[],previews=[],stageAttempts=[];
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
  if(ep===`/api/v1/projects/${pid}/stages/${stages[1].id}`&&method==='PUT'){
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
   else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/ai/status'))data={enabled:false,configured:false,entitled:true,allowedHere:true};
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep==='/api/v1/chat/projects/unread')data=[];
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 for(const width of [1440,390]){
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error'&&!e.text().startsWith('Failed to load resource'))errors.push(e.text());});await page.setViewportSize({width,height:1000});await page.goto(origin+`/preview-org/projects/${pid}?tab=list`);
  // The timeline card: nothing in its header, summary or stages overlaps anything else, at any width.
  await page.locator('.tl-card').waitFor({timeout:15000});await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(300);
  const clash=await page.evaluate(()=>{const card=document.querySelector('.tl-card');const els=[...card.querySelectorAll('.tl-actions > *, .tl-progress-top > *, .tl-legend li, .tl-segments, .htl-dot, .htl-body, h3')].filter(e=>e.getClientRects().length);
   const r=els.map(e=>e.getBoundingClientRect());const out=[];for(let i=0;i<r.length;i++)for(let j=i+1;j<r.length;j++){if(els[i].contains(els[j])||els[j].contains(els[i]))continue;const a=r[i],b=r[j];
    if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1)out.push(`${els[i].className||els[i].tagName} x ${els[j].className||els[j].tagName}`);}
   return {out,overflow:card.scrollWidth>card.clientWidth+1};});
  assert.deepEqual(clash.out,[],`timeline overlaps at ${width}`);await page.locator('.tl-card').screenshot({path:path.join(out,`timeline-${width}.png`)});checks.push(`timeline-layout-${width}`);
  try{await page.getByRole('button',{name:'Schedule studio',exact:true}).click({timeout:15000});}catch(e){await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({errors,body:await page.locator('body').innerText()}));throw e;}
  const dialog=page.getByRole('dialog');await dialog.waitFor();await page.evaluate(()=>document.fonts.ready);
  assert.equal(await dialog.getByLabel('Created duration in calendar days').isDisabled(),true,'Completed allocation is protected');
  assert.equal(await dialog.getByRole('combobox').innerText(),'Project end follows the final stage');
  await dialog.getByRole('button',{name:'Distribute available days'}).click();assert.equal(await dialog.getByLabel('Launch duration in calendar days').inputValue(),'0','Milestones stay zero');
  await dialog.getByLabel('Design duration in calendar days').fill('7');await dialog.getByLabel('Schedule change reason').fill('Approved additional design review');
  assert.equal(await dialog.getByRole('button',{name:'Apply schedule'}).count(),0,'Preview required before apply');
  await dialog.getByRole('button',{name:'Preview schedule'}).click();await dialog.getByRole('button',{name:'Apply schedule'}).waitFor();
  assert.match(await dialog.locator('.schedule-preview').innerText(),/14 Jan 2030/);assert.equal(saves.length,width===1440?0:1,'Preview does not save');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'No viewport overflow');assert.deepEqual(await cutOff(page),[],'cut off at the right edge');
  const bounded=await dialog.locator('.schedule-stage-row').evaluateAll(rows=>rows.every(row=>[...row.children].every(c=>c.getBoundingClientRect().right<=row.getBoundingClientRect().right+1)));
  assert.ok(bounded,'Allocation controls stay within each row');await dialog.locator('.schedule-preview').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`schedule-preview-${width}.png`),animations:'disabled'});checks.push(`preview-${width}`);
  if(width===1440){
   await dialog.getByLabel('Design duration in calendar days').fill('8');assert.equal(await dialog.getByRole('button',{name:'Apply schedule'}).count(),0,'Editing expires the preview');
   await dialog.getByLabel('Design duration in calendar days').fill('7');await dialog.getByRole('button',{name:'Apply schedule'}).click();await dialog.waitFor({state:'hidden'});assert.equal(saves.length,1);checks.push('save-reviewed-fingerprint');
   await page.getByRole('button',{name:'Edit Design',exact:true}).click();await dialog.getByLabel('Planned start',{exact:true}).fill('2030-01-03');
   assert.equal(await dialog.getByLabel('Planned end',{exact:true}).inputValue(),'2030-01-07','Manual start preserves duration');
   await dialog.getByRole('button',{name:'Save stage',exact:true}).click();await dialog.getByText('Say why the project end needs to move later.',{exact:true}).waitFor();assert.equal(stageAttempts.length,1);
   checks.push('manual-start-duration-and-visible-extension-validation');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  }else{
   await dialog.getByRole('combobox').click();await page.getByRole('option',{name:'Keep project end fixed',exact:true}).click();await dialog.getByRole('button',{name:'Preview schedule'}).click();await dialog.getByRole('alert').waitFor();
   assert.match(await dialog.getByRole('alert').innerText(),/3 day\(s\).*Nothing was saved/);assert.equal(await dialog.getByRole('button',{name:'Apply schedule'}).count(),0);assert.equal(saves.length,1);
   await dialog.getByRole('alert').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'schedule-validation-390.png'),animations:'disabled'});checks.push('fixed-overflow-validation');
  }
  await page.close();
 }
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,previews:previews.length,saves:saves.length,rejectedStageEdits:stageAttempts.length,errors,scope:'Built frontend with synthetic fixtures; no customer or live AI writes.'},null,2));console.log(JSON.stringify({checks,saves:saves.length,errors}));
}finally{await browser.close();}
