import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Connected accounts and where meetings go: the meeting-service choice (only what is connected can be chosen), one feature of an account
// switched off on its own (Calendar stays when Gmail stops), Slack linked with its message choice, and the schedule form that names the
// service and opens a Project Tracker call in the app. Synthetic API fixtures only: no provider is contacted.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve(process.env.PM_UI_ARTIFACTS||'test-results/enterprise-ui','connected');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false,mfaEnabled:true};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4,timeZone:null};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const perms=['org.manage','projects.view','projects.edit','tasks.view','work.view','calendar.view'];
const project={id:'00000000-0000-0000-0000-0000000000a1',key:'ATL',name:'Atlas'};
const now=new Date().toISOString();
let google={connected:true,configured:true,googleEmail:'asha@gmail.example.test',connectedAt:now,lastError:null,calendarAccess:true,mailEnabled:true,mailSendAccess:true,inboxEnabled:true,inboxAccess:true,transcriptAccess:false};
let microsoft={enabled:true,configured:true,connected:false,email:null,mailSendAccess:false,inboxEnabled:true,inboxAccess:false,calendarsEnabled:true,calendarAccess:false,connectedAt:null,meetingsEnabled:true,meetingsAccess:false};
let slack={available:true,workspaceConnected:true,teamName:'Preview HQ',linked:true,name:'Asha Rao',messages:'needs',problem:null};
let service='auto';
const choice=()=>{const g=google.connected&&google.calendarAccess;const p=service==='ours'?'ours':service==='google'||g?'google':'ours';
 return {preference:service,provider:p,name:p==='google'?'Google Meet':'Project Tracker call',reason:p==='google'?'Your Google account is connected, so meetings go to Google Calendar with a Meet link.':service==='ours'?'You chose Project Tracker calls.':'No calendar is connected, so meetings are Project Tracker calls. The project agent can join them.',googleReady:!!g,microsoftReady:false,ownCallsReady:true};};
const accounts=()=>({google,microsoft,slack,gitHub:{available:true,linked:false,email:null,appInstalled:true},meetingService:service,meetings:choice(),meetingProblem:null});
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin||ep.startsWith('/hubs/')){await route.abort();return;}
  if(ep.endsWith('/avatar')||ep.endsWith('/logo/file')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  const body=()=>{try{return req.postDataJSON();}catch{return null;}};
  const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(status<300?{data}:data)});
  if(method!=='GET'&&!ep.endsWith('/auth/refresh')&&ep!=='/api/v1/me/ui/sidebar'&&!ep.endsWith('/read')&&!ep.endsWith('/presence')){
   writes.push({ep,method,b:body()});
   if(ep==='/api/v1/me/connected-accounts'&&method==='PUT'){const b=body();if(b.meetingService)service=b.meetingService;if(b.slackMessages)slack={...slack,messages:b.slackMessages};return json(accounts());}
   if(ep==='/api/v1/integrations/google/features/inbox/off'){google={...google,inboxAccess:false};return json(google);}
   if(ep===`/api/v1/projects/${project.id}/meetings/schedule`){const b=body();const ours=(b.service??'auto')==='ours'||choice().provider==='ours';
    return json({id:'m1',projectId:project.id,title:b.title,description:null,startTime:b.startTime,endTime:b.endTime,timeZone:b.timeZone,status:'Scheduled',
     meetUri:ours?'/calls/meeting/m1':'https://meet.google.com/abc-defg-hij',organizerUserId:user.id,organizerName:user.displayName,participants:[],provider:ours?'ours':'google',providerName:ours?'Project Tracker call':'Google Meet'},201);}
   if(ep==='/api/v1/meetings/schedule'){const b=body();const ours=(b.service??'auto')==='ours'||choice().provider==='ours';
    return json({id:'m1',title:b.title,meetUri:ours?'/calls/meeting/w/m1':'https://meet.google.com/abc-defg-hij',calendarUrl:null,startTime:b.startTime,endTime:b.endTime,timeZone:b.timeZone,recurrenceRule:null,participantCount:1,provider:ours?'ours':'google',providerName:ours?'Project Tracker call':'Google Meet'},201);}
   if(ep==='/api/v1/calls/meeting/w/m1'||ep==='/api/v1/calls/meeting/m1')return json({id:'c1',title:'Atlas review',kind:'project',projectId:project.id,projectKey:'ATL',conversationId:null,status:'live',startedAt:now,endedAt:null,startedBy:user.id,startedByName:user.displayName,agentEnabled:true,agentStatus:null,canEnd:true,people:[]});
   if(ep==='/api/v1/calls/c1/join')return json(null,409);
   assert.fail(`Unexpected write: ${method} ${ep}`);
  }
  let data=[];
  if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
  else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
  else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:perms,modules:{projects:3,tasks:3,work:3,ai:3,calendar:3,documents:3,members:3,organization:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
  else if(ep==='/api/v1/me/connected-accounts')data=accounts();
  else if(ep==='/api/v1/integrations/microsoft/status')data=microsoft;
  else if(ep==='/api/v1/integrations/google/status')data=google;
  else if(ep==='/api/v1/me/microsoft-calendars')data={calendars:[]};
  else if(ep.startsWith('/api/v1/me/calendar-proposals'))data=[];
  else if(ep===`/api/v1/projects/${project.id}/meetings/participants`)data=[{userId:'u2',name:'Ravi Kumar',email:'ravi@example.test',role:'Member',rsvpStatus:'NeedsAction'}];
  else if(ep==='/api/v1/meetings/participants')data=[{userId:user.id,name:user.displayName,email:user.email,role:'Owner',rsvpStatus:'NeedsAction'},{userId:'u2',name:'Ravi Kumar',email:'ravi@example.test',role:'Member',rsvpStatus:'NeedsAction'}];
  else if(ep==='/api/v1/projects')data={items:[project],page:1,totalPages:1,totalItems:1};
  else if(ep==='/api/v1/calls/status')data={available:true,maxParticipants:50};
  else if(ep==='/api/v1/calls/live')data=[];
  else if(ep==='/api/v1/calls/c1')data={id:'c1',title:'Atlas review',kind:'project',projectId:project.id,projectKey:'ATL',conversationId:null,status:'live',startedAt:now,endedAt:null,startedBy:user.id,startedByName:user.displayName,agentEnabled:true,agentStatus:null,canEnd:true,people:[]};
  else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
  else if(ep==='/api/v1/workspace/logo')data={hasLogo:false};
  else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
  else if(ep==='/api/v1/notifications/counts')data={unread:0,needsYou:0,forInfo:0,snoozed:0};
  else if(ep==='/api/v1/notifications')data={items:[],page:1,pageSize:20,totalPages:0,totalItems:0};
  else if(ep==='/api/v1/timer')data=null;
  else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
  else if(ep==='/api/v1/chat/projects/unread')data=[];
  else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  await json(data);
 });
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(250);await page.screenshot({path:path.join(out,name),fullPage:true});};
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 try{
  // 1. Where meetings go: automatic names Google Meet; Teams cannot be chosen until Microsoft is connected; choosing our own calls saves.
  await page.goto(origin+'/preview-org/account/integrations');
  const meet=page.getByTestId('ca-meetings');await meet.waitFor();
  await meet.getByText('Your next meeting:').waitFor();
  assert.match(await meet.getByRole('status').innerText(),/Google Meet/);
  assert.equal(await page.getByTestId('ca-service-auto').getAttribute('aria-checked'),'true');
  assert.ok(await page.getByTestId('ca-service-microsoft').isDisabled(),'Teams waits for Microsoft');
  await page.getByTestId('ca-service-ours').click();
  await meet.getByText('You chose Project Tracker calls.').waitFor();
  assert.deepEqual(writes.at(-1).b,{meetingService:'ours'});
  assert.equal(await page.getByTestId('ca-service-ours').getAttribute('aria-checked'),'true');
  checks.push('meeting-service-choice');

  // 2. One Google feature off: the inbox stops, Calendar and Meet stay on, after confirming.
  await page.getByTestId('ca-google-inbox-off').click();
  await page.getByRole('dialog').getByRole('button',{name:'Turn off'}).click();
  await page.getByTestId('ca-google-inbox-on').waitFor();
  assert.ok(writes.some(w=>w.ep==='/api/v1/integrations/google/features/inbox/off'));
  assert.ok(await page.getByTestId('ca-google-calendar-off').isVisible(),'Calendar and Meet keep working');
  assert.ok(await page.getByTestId('ca-google-mail-off').isVisible(),'sending mail keeps working');
  checks.push('google-feature-off-alone');

  // 3. Slack: linked, what reaches Slack is a choice.
  const sl=page.getByTestId('ca-slack');
  assert.match(await sl.innerText(),/Asha Rao · Preview HQ/);
  assert.equal(await page.getByTestId('ca-slack-needs').getAttribute('aria-checked'),'true');
  await page.getByTestId('ca-slack-all').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="ca-slack-all"]')?.getAttribute('aria-checked')==='true');
  assert.deepEqual(writes.at(-1).b,{slackMessages:'all'});
  checks.push('slack-message-choice');
  assert.ok(await page.getByTestId('ca-microsoft-connect').isVisible());
  assert.ok(await page.getByTestId('ca-github-link').isVisible());
  await shot(page,'connected-desktop.png');

  // 4. A phone: the page fits.
  await page.setViewportSize({width:390,height:844});await page.reload();await page.getByTestId('ca-meetings').waitFor();
  await fitsPhone(page,'connected accounts',assert);await shot(page,'connected-phone.png');
  checks.push('phone-fits');

  // 5. Scheduling (in Meet, the one place for meetings) names the service, and a Project Tracker call opens in the app (no project).
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(origin+'/preview-org/meet/upcoming');   // v2: Meet's views are Talk › all meetings
  await page.getByRole('button',{name:'Schedule',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Title',{exact:true}).fill('Atlas review');
  const svc=page.getByRole('combobox',{name:'Meeting service'});await svc.waitFor();
  assert.match(await svc.locator('option:checked').innerText(),/your choice: Project Tracker call/);
  assert.deepEqual((await svc.locator('option').allInnerTexts()).map(x=>x.split(' (')[0]),['Automatic','Google Meet','Project Tracker call']);
  assert.match(await page.locator('.gm-invite-note').innerText(),/One Project Tracker call/);
  await page.getByRole('button',{name:'Send invitation'}).click();
  const ready=page.getByTestId('meeting-ready');await ready.waitFor();
  assert.match(await ready.innerText(),/Project Tracker call ready/);
  assert.equal(writes.find(w=>w.ep==='/api/v1/meetings/schedule').b.service,'auto');
  assert.match(await ready.locator('code').innerText(),/\/preview-org\/calls\/meeting\/w\/m1$/);
  await shot(page,'schedule-ready.png');
  await ready.getByRole('link',{name:'Join Meeting'}).click();
  await page.waitForURL(/\/calls\/c1$/);
  assert.ok(writes.some(w=>w.ep==='/api/v1/calls/meeting/w/m1'));
  checks.push('schedule-names-service-and-joins-our-call');
 }catch(e){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error('page errors:',errors);throw e;}
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify({fixture:'Synthetic APIs only',checks,pageErrors:errors},null,2));
 console.log(JSON.stringify({checks,pageErrors:errors,artifacts:out}));
}finally{await browser.close();}
