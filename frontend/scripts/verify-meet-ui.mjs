import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Meet, the one place for meetings and calls: the sidebar entry, the upcoming list with replies and Join, one meeting's detail (opened from a
// link as reminders and notifications do), the notetaker chosen on the schedule form (with the reason when voice is not possible), past
// meetings with notes, series, and the Calendar opening meetings here. Synthetic API fixtures only: no provider is contacted.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve(process.env.PM_UI_ARTIFACTS||'test-results/enterprise-ui','meet');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false,mfaEnabled:true};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4,timeZone:null};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const perms=['org.manage','projects.view','projects.edit','tasks.view','work.view','calendar.view'];
const project={id:'00000000-0000-0000-0000-0000000000a1',key:'ATL',name:'Atlas'};
const ids={ours:'00000000-0000-0000-0000-0000000000b1',meet:'00000000-0000-0000-0000-0000000000b2',team:'00000000-0000-0000-0000-0000000000b3',past:'00000000-0000-0000-0000-0000000000b4'};
const at=(minutes)=>new Date(Date.now()+minutes*60_000).toISOString();
// the calendar's "today" is the user's day (Asia/Kolkata), not UTC: between 18:30 and 24:00 UTC they differ
const istDate=(iso)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
let myReply='NeedsAction';
const item=(o)=>({kind:'project',description:null,timeZone:'Asia/Kolkata',projectId:project.id,projectName:project.name,projectKey:project.key,calendarUrl:null,isScrum:false,recurring:false,sessionsLeft:null,
  notetaker:'off',isOrganizer:false,canManage:false,organizerName:'Ravi Kumar',invited:3,accepted:1,declined:0,status:'Scheduled',notes:null,live:false,...o,ref:`${o.kind==='workspace'?'w':'p'}:${o.id}`});
const upcoming=()=>[
  item({id:ids.ours,title:'Atlas review',start:at(5),end:at(35),provider:'ours',providerName:'Project Tracker call',joinUrl:`/calls/meeting/${ids.ours}`,myRsvp:myReply,notetaker:'voice'}),
  item({id:ids.meet,title:'Client sync',start:at(26*60),end:at(26*60+30),provider:'google',providerName:'Google Meet',joinUrl:'https://meet.google.com/abc-defg-hij',myRsvp:'Accepted',notetaker:'transcript',calendarUrl:'https://calendar.google.com/event?eid=x'}),
  item({id:ids.team,kind:'workspace',projectId:null,projectName:null,projectKey:null,title:'Team stand-up',start:at(48*60),end:at(48*60+15),provider:'ours',providerName:'Project Tracker call',joinUrl:`/calls/meeting/w/${ids.team}`,myRsvp:'Organizer',isOrganizer:true,canManage:true,isScrum:true,recurring:true,organizerName:user.displayName}),
];
const past=[item({id:ids.past,title:'Kick-off',start:at(-26*60),end:at(-25*60),provider:'google',providerName:'Google Meet',joinUrl:'https://meet.google.com/old-call',myRsvp:'Accepted',notetaker:'transcript',notes:'done'})];
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
   if(ep===`/api/v1/meet/p/${ids.ours}/rsvp`){myReply=body().response==='accepted'?'Accepted':body().response==='declined'?'Declined':'Tentative';return json({rsvp:myReply});}
   if(ep===`/api/v1/projects/${project.id}/meetings/schedule`){const b=body();return json({id:'m9',projectId:project.id,title:b.title,description:null,startTime:b.startTime,endTime:b.endTime,timeZone:b.timeZone,status:'Scheduled',
     meetUri:'/calls/meeting/m9',organizerUserId:user.id,organizerName:user.displayName,participants:[],provider:'ours',providerName:'Project Tracker call',notetaker:b.notetaker},201);}
   if(ep===`/api/v1/meetings/workspace/${ids.team}/cancel`)return json(null,204);
   assert.fail(`Unexpected write: ${method} ${ep}`);
  }
  let data=[];
  if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
  else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
  else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:perms,modules:{projects:3,tasks:3,work:3,ai:3,calendar:3,documents:3,members:3,organization:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
  else if(ep==='/api/v1/meet'){const from=new Date(url.searchParams.get('from'));data={items:from<new Date(Date.now()-24*3600_000)?past:upcoming(),from:url.searchParams.get('from'),to:url.searchParams.get('to'),truncated:false};}
  else if(ep==='/api/v1/meet/series')data=[{...upcoming()[2],sessionsLeft:9}];
  else if(ep==='/api/v1/meet/notetaker')data={available:true,reason:null,voiceAvailable:false,voiceReason:'Voice needs the speech service, which is not set up here. Transcription works.',canSwitchOn:true};
  else if(ep===`/api/v1/meetings/${ids.ours}`)data={id:ids.ours,projectId:project.id,title:'Atlas review',description:'Release scope\nOpen risks',startTime:at(5),endTime:at(35),timeZone:'Asia/Kolkata',status:'Scheduled',meetUri:`/calls/meeting/${ids.ours}`,
    organizerUserId:'u2',organizerName:'Ravi Kumar',provider:'ours',providerName:'Project Tracker call',notetaker:'voice',recurrenceRule:null,isScrum:false,
    participants:[{userId:'u2',name:'Ravi Kumar',email:'ravi@example.test',role:'Organizer',rsvpStatus:'Accepted'},{userId:user.id,name:user.displayName,email:user.email,role:'Attendee',rsvpStatus:myReply==='Organizer'?'Accepted':myReply},{userId:'u3',name:'Priya Shah',email:'priya@example.test',role:'Attendee',rsvpStatus:'Declined'}]};
  else if(ep===`/api/v1/meetings/workspace/${ids.team}`)data={id:ids.team,title:'Team stand-up',description:null,startTime:at(48*60),endTime:at(48*60+15),timeZone:'Asia/Kolkata',status:'Scheduled',meetUri:`/calls/meeting/w/${ids.team}`,
    calendarUrl:null,recurrenceRule:'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10',isScrum:true,organizerUserId:user.id,organizerName:user.displayName,canManage:true,provider:'ours',providerName:'Project Tracker call',
    attendees:[{userId:user.id,name:user.displayName,email:user.email,role:'Organizer',rsvpStatus:'Accepted'},{userId:'u2',name:'Ravi Kumar',email:'ravi@example.test',role:'Attendee',rsvpStatus:'Tentative'}]};
  else if(ep==='/api/v1/agent/meetings')data=[{id:'cal1',meetingId:null,projectId:null,projectKey:null,projectName:null,title:'Vendor call',startUtc:at(3*60),endUtc:at(3*60+30),meetUrl:'https://teams.microsoft.com/l/meetup-join/vendor',organizer:false,project:false,agentEnabled:false,agentAttending:false,delegationId:null,delegationStatus:null,overlapsWith:[]}];
  else if(ep==='/api/v1/me/connected-accounts')data={google:{connected:false},microsoft:{connected:false},slack:{available:false},gitHub:{available:false},meetingService:'auto',meetings:{preference:'auto',provider:'ours',name:'Project Tracker call',reason:'No calendar is connected, so meetings are Project Tracker calls.',googleReady:false,microsoftReady:false,ownCallsReady:true},meetingProblem:null};
  else if(ep===`/api/v1/projects/${project.id}/meetings/participants`)data=[{userId:'u2',name:'Ravi Kumar',email:'ravi@example.test',role:'Member',rsvpStatus:'NeedsAction'}];
  else if(ep==='/api/v1/meetings/participants')data=[{userId:'u2',name:'Ravi Kumar',email:'ravi@example.test',role:'Member',rsvpStatus:'NeedsAction'}];
  else if(ep==='/api/v1/projects')data={items:[project],page:1,totalPages:1,totalItems:1};
  else if(ep==='/api/v1/calendar')data=[{type:'meeting',id:ids.ours,title:'Atlas review',date:istDate(at(5)),startsAt:at(5),projectId:project.id,projectName:project.name,category:null,overdue:false,status:null,priority:null}];
  else if(ep==='/api/v1/calls/status')data={available:true,maxParticipants:50};
  else if(ep==='/api/v1/calls/live')data=[];
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
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource'))console.error('console:',m.text().slice(0,400));});await page.setViewportSize({width:1440,height:1000});
 const shot=(name)=>page.screenshot({path:path.join(out,name),animations:'disabled'});
 try{
  // 1. One entry: Talk in the rail, Meetings among its filters (the old address lands there); Talk's ··· opens all meetings, where the list
  // shows what is coming with each person's reply and Join only when it is near.
  await page.goto(origin+'/preview-org/meet');await page.waitForURL(/\/talk\?f=meetings/);
  await page.locator('.v2-rail-item.on',{hasText:'Talk'}).waitFor();
  assert.equal(await page.locator('.talk-filters .ds-chip',{hasText:'Meetings'}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'More in Talk'}).click();await page.getByRole('menuitem',{name:/All meetings/}).click();
  await page.waitForURL(/[?&]s=upcoming/);
  const rows=page.locator('.mt-item');await rows.first().waitFor();
  assert.equal(await rows.count(),4,'Three meetings and one call from the calendar');
  const review=rows.filter({hasText:'Atlas review'});
  assert.ok(await review.getByRole('link',{name:'Join'}).isVisible(),'Starting soon: Join is there');
  assert.equal(await review.getByRole('link',{name:'Join'}).getAttribute('href'),`/preview-org/calls/meeting/${ids.ours}`,'A Project Tracker call opens in the app');
  assert.equal(await rows.filter({hasText:'Client sync'}).getByRole('link',{name:'Join'}).count(),0,'Tomorrow: no Join yet');
  assert.match(await review.innerText(),/Notetaker with voice/);
  assert.match(await rows.filter({hasText:'Vendor call'}).innerText(),/On your calendar/);
  assert.equal(await rows.filter({hasText:'Vendor call'}).getByRole('link',{name:'Send notetaker'}).getAttribute('href'),
    `/preview-org/meet/notetaker?url=${encodeURIComponent('https://teams.microsoft.com/l/meetup-join/vendor')}&title=Vendor%20call`);
  await shot('meet-upcoming-1440.png');checks.push('list');

  // 2. Replying to a Project Tracker call from the list.
  await review.getByRole('button',{name:'Accept'}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.mt-item')].some(li=>li.textContent.includes('Atlas review')&&li.textContent.includes('Going')));
  assert.deepEqual(writes.at(-1),{ep:`/api/v1/meet/p/${ids.ours}/rsvp`,method:'POST',b:{response:'accepted'}});checks.push('reply-from-list');

  // 3. One meeting, opened from a link (reminders and notifications use these): people, agenda, the notetaker, and the reply. v2: it opens
  // in Talk's own pane.
  await page.goto(origin+`/preview-org/meet?open=p:${ids.ours}`);await page.waitForURL(/[?&]meeting=p(:|%3A)/);
  const d=page.locator('.mt-inline');await d.getByRole('heading',{name:'Atlas review'}).waitFor();
  assert.match(await d.locator('.mt-props').innerText(),/speaks up when something is missed/);
  assert.match(await d.locator('.mt-agenda').innerText(),/Release scope/);
  assert.match(await d.innerText(),/1 not going/);
  await d.getByRole('group',{name:'Your reply'}).getByRole('button',{name:'No'}).click();await page.waitForTimeout(300);
  assert.deepEqual(writes.at(-1).b,{response:'declined'});
  assert.equal(await d.getByRole('button',{name:'Cancel meeting'}).count(),0,'Only the organizer cancels');
  await shot('meet-detail-1440.png');checks.push('detail-and-reply');

  // 4. Schedule (from Talk's ···): the notetaker is chosen per meeting; voice says why it cannot come; the choice is sent.
  await page.getByRole('button',{name:'More in Talk'}).click();await page.getByRole('menuitem',{name:/Schedule a meeting/}).click();
  const f=page.getByRole('dialog');await f.getByRole('heading',{name:'Schedule a meeting'}).waitFor();
  assert.match(await f.locator('.mt-notetaker').innerText(),/Choose a project to bring the notetaker/);
  await f.getByLabel('Project',{exact:true}).selectOption(project.id);
  const voice=f.getByRole('radio',{name:/Transcription \+ voice suggestions/});await voice.waitFor();
  assert.ok(await voice.isDisabled());assert.match(await f.locator('.mt-notetaker').innerText(),/Voice needs the speech service/);
  await f.getByRole('radio',{name:/^Transcription Listens/}).check();
  await f.getByLabel('Title',{exact:true}).fill('Release go/no-go');
  await f.locator('input[type=date]').fill('2030-01-07');await f.locator('input[type=time]').fill('11:00');
  await shot('meet-schedule-1440.png');
  await f.getByRole('button',{name:'Send invitation'}).click();await f.getByTestId('meeting-ready').waitFor();
  const sent=writes.find(w=>w.ep===`/api/v1/projects/${project.id}/meetings/schedule`).b;
  assert.equal(sent.notetaker,'transcript');assert.equal(sent.startTime,'2030-01-07T05:30:00.000Z');assert.deepEqual(sent.participantUserIds,['u2']);
  await f.getByRole('button',{name:'Done',exact:true}).click();checks.push('schedule-with-notetaker');

  // 5. The organizer of a series cancels it from its detail.
  await page.goto(origin+'/preview-org/meet/series');const series=page.locator('.mt-item').filter({hasText:'Team stand-up'});await series.waitFor();
  assert.match(await series.innerText(),/9 sessions left/);
  await series.locator('.mt-item-main').click();const sd=page.getByRole('dialog');await sd.getByRole('heading',{name:'Team stand-up'}).waitFor();
  assert.match(await sd.innerText(),/1 maybe/);
  await sd.getByRole('button',{name:'Cancel series'}).click();await page.getByRole('dialog',{name:'Cancel the whole series?'}).getByRole('button',{name:'Cancel series'}).click();await page.waitForTimeout(300);
  assert.equal(writes.at(-1).ep,`/api/v1/meetings/workspace/${ids.team}/cancel`);checks.push('series-cancel');

  // 6. Past meetings show the notetaker's notes.
  await page.goto(origin+'/preview-org/meet/past');const kick=page.locator('.mt-item').filter({hasText:'Kick-off'});await kick.waitFor();
  assert.match(await kick.innerText(),/Notes/);assert.equal(await kick.getByRole('link',{name:'Join'}).count(),0);checks.push('past');

  // 7. The Calendar (Home › Calendar in v2) shows meetings and opens them in Talk; it has no meeting button of its own.
  await page.goto(origin+'/preview-org/calendar');await page.locator('[data-testid="week-planner"]').waitFor();
  assert.equal(await page.getByRole('button',{name:/Scrum call|Schedule/}).count(),0);
  // Clicking a planner event selects it and shows the inspector; the meeting opens in Talk from the inspector.
  const ev=page.locator('.wp-e',{hasText:'Atlas review'});await ev.click();assert.equal(await ev.getAttribute('aria-pressed'),'true','the clicked event is selected');
  await page.locator('.wp-insp').getByRole('heading',{name:'Atlas review'}).waitFor();
  // The notes switch is aria-disabled (the notetaker is set on the meeting), so Playwright will not click it; dispatch the click it handles.
  await page.locator('.wp-insp [title^="The notetaker is set"]').dispatchEvent('click');await page.waitForURL(/[?&](open|meeting)=p(:|%3A)/);
  await page.locator('.mt-inline').getByRole('heading',{name:'Atlas review'}).waitFor();checks.push('calendar-opens-meet');

  // 8. Old addresses lead to Meet.
  await page.goto(origin+'/preview-org/notetaker?session=s1');await page.waitForURL(/\/talk\?session=s1&f=meetings&s=notetaker$/);checks.push('old-address');

  // 9. A phone: the list fits and Join stays reachable.
  await page.setViewportSize({width:390,height:844});await page.goto(origin+'/preview-org/meet/upcoming');await page.locator('.mt-item').first().waitFor();
  await fitsPhone(page,'meet',assert);assert.ok(await page.locator('.mt-item').filter({hasText:'Atlas review'}).getByRole('link',{name:'Join'}).isVisible());
  await shot('meet-390.png');checks.push('phone');
 }catch(e){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error('page errors:',errors);throw e;}
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify({fixture:'Synthetic APIs only',checks,pageErrors:errors},null,2));
 console.log(JSON.stringify({checks,pageErrors:errors,artifacts:out}));
}finally{await browser.close();}
