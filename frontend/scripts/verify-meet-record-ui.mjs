import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';
import { timelineFor } from './lib/timeline.mjs';

// Meet, the one place for meetings and calls: the sidebar entry, the upcoming list with replies and Join, one meeting's detail (opened from a
// link as reminders and notifications do), the notetaker chosen on the schedule form (with the reason when voice is not possible), past
// meetings with notes, series, and the Calendar opening meetings here. Synthetic API fixtures only: no provider is contacted.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve(process.env.PM_UI_ARTIFACTS||'test-results/enterprise-ui','meet-record');
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
let myReply='NeedsAction';let segments=0;
const item=(o)=>({kind:'project',description:null,timeZone:'Asia/Kolkata',projectId:project.id,projectName:project.name,projectKey:project.key,calendarUrl:null,isScrum:false,recurring:false,sessionsLeft:null,
  notetaker:'off',isOrganizer:false,canManage:false,organizerName:'Ravi Kumar',invited:3,accepted:1,declined:0,status:'Scheduled',notes:null,live:false,...o,ref:`${o.kind==='workspace'?'w':'p'}:${o.id}`});
const upcoming=()=>[
  item({id:ids.ours,title:'Atlas review',start:at(5),end:at(35),provider:'ours',providerName:'Project Tracker call',joinUrl:`/calls/meeting/${ids.ours}`,myRsvp:myReply,notetaker:'voice'}),
  item({id:ids.meet,title:'Client sync',start:at(26*60),end:at(26*60+30),provider:'google',providerName:'Google Meet',joinUrl:'https://meet.google.com/abc-defg-hij',myRsvp:'Accepted',notetaker:'transcript',calendarUrl:'https://calendar.google.com/event?eid=x'}),
  item({id:ids.team,kind:'workspace',projectId:null,projectName:null,projectKey:null,title:'Team stand-up',start:at(48*60),end:at(48*60+15),provider:'ours',providerName:'Project Tracker call',joinUrl:`/calls/meeting/w/${ids.team}`,myRsvp:'Organizer',isOrganizer:true,canManage:true,isScrum:true,recurring:true,organizerName:user.displayName}),
];
const past=[item({id:ids.past,title:'Kick-off',start:at(-26*60),end:at(-25*60),provider:'google',providerName:'Google Meet',joinUrl:'https://meet.google.com/old-call',myRsvp:'Accepted',notetaker:'transcript',notes:'done'})];
// The call log: an ad-hoc call Aura took notes in, and a call I missed.
const callLog=[
  {id:'c1',title:'Vendor escalation',kind:'adhoc',projectId:null,projectKey:null,conversationId:null,status:'ended',startedAt:at(-90),endedAt:at(-66),minutes:24,missed:false,startedByMe:true,startedByName:user.displayName,people:[user.displayName,'Ravi Kumar','Priya Shah'],hasNotes:true},
  {id:'c2',title:'Call',kind:'adhoc',projectId:null,projectKey:null,conversationId:null,status:'ended',startedAt:at(-30*60),endedAt:at(-30*60+2),minutes:2,missed:true,startedByMe:false,startedByName:'Ravi Kumar',people:['Ravi Kumar'],hasNotes:false},
];
const callDto=(id)=>{const c=callLog.find((x)=>x.id===id);return{id,title:c.title,kind:c.kind,projectId:null,projectKey:null,conversationId:null,status:'ended',startedAt:c.startedAt,endedAt:c.endedAt,startedBy:c.startedByMe?user.id:'u2',startedByName:c.startedByName,
  agentEnabled:id==='c1',agentStatus:null,canEnd:false,people:[{userId:user.id,name:user.displayName,role:c.startedByMe?'host':'member',inCall:false,joinedAt:c.missed?null:c.startedAt},{userId:'u2',name:'Ravi Kumar',role:c.startedByMe?'member':'host',inCall:false,joinedAt:c.startedAt}]};};
const notes={callId:'c1',status:'ready',summary:'The redirect fix ships today and the full release on Friday. Priya tells the vendor at 16:00.',decisions:[],sessionId:'s1',
  actions:[{task:'Ship the redirect fix today',owner:'Ravi Kumar',due:'Today'},{task:'Send the vendor the fix date',owner:'Asha Rao',due:'Today'},{task:'Write the incident note',owner:'Asha Rao',due:'Fri'}],
  transcript:[{speaker:'Priya Shah',text:'Their team still loops after resetting passwords. About forty people.'},{speaker:'Ravi Kumar',text:'The redirect address changed on Monday. The fix is in staging.'},{speaker:'Asha Rao',text:'It goes live today, and it is part of Friday\'s release.'},{speaker:'Priya Shah',text:'Great. I will tell the vendor at 16:00 once you confirm.'}]};
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');if(!sessionStorage.getItem('pm_no_record_preview'))localStorage.setItem('pm_record_preview','1');if(!localStorage.getItem('pm_theme_set'))localStorage.setItem('pm_theme','light');});
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
   if(ep==='/api/v1/me/recordings')return json({id:'rec1',meetingId:ids.ours,title:'Atlas review',status:'in_call',lines:0,speech:true},201);
   if(ep==='/api/v1/me/recordings/rec1/segment'){segments++;return json({who:segments%2?'Asha Rao':'Others',lang:segments%2?'te':'en',text:segments%2?'రేపటికి confirm చేస్తాను':'Fine, book the assessor call.',offset:segments});}
   if(ep==='/api/v1/me/recordings/rec1/finish')return json({sessionId:'rec1',title:'Atlas review',content:{title:'Atlas review',summary:'The release deck goes out this week.',attendees:[],discussion:['Release deck'],decisions:[],risks:[],nextMeeting:null,actionItems:[{task:'Send the release deck',owner:null,due:null},{task:'Book the assessor call',owner:'Asha Rao',due:'2026-11-20'}]}});
   if(ep==='/api/v1/me/recordings/rec1/tasks')return json({created:body().items.map(()=>'x')});
   assert.fail(`Unexpected write: ${method} ${ep}`);
  }
  let data=[];
  if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
  else if(ep==='/api/v1/me/recordings/status')data={speech:true};
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
  else if(ep==='/api/v1/timeline')data=timelineFor(url,[{type:'meeting',id:ids.ours,title:'Atlas review',date:istDate(at(5)),startsAt:at(5),projectId:project.id,projectName:project.name,category:null,overdue:false,status:null,priority:null}]);
  else if(ep==='/api/v1/calls/status')data={available:true,maxParticipants:50};
  else if(ep==='/api/v1/calls/live')data=[];
  else if(ep==='/api/v1/calls/history')data=callLog;
  else if(/^\/api\/v1\/calls\/c[12]$/.test(ep))data=callDto(ep.split('/')[4]);
  else if(/^\/api\/v1\/calls\/c[12]\/notes$/.test(ep))data=ep.includes('/c1/')?notes:{callId:'c2',status:'none',summary:null,actions:[],decisions:[],transcript:[],sessionId:null};
  else if(ep.endsWith('/workspace/members'))data=[{userId:user.id,displayName:user.displayName,email:user.email,role:'Owner'},{userId:'u2',displayName:'Ravi Kumar',email:'ravi@example.test',role:'Member'}];
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
const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 const shot=(name)=>page.screenshot({path:path.join(out,name),animations:'disabled'});
 const open=async(state)=>{await page.evaluate((s)=>localStorage.setItem('pm_record_state',s),state);await page.goto(origin+`/preview-org/meetings?open=p:${ids.ours}`);await page.getByTestId('meeting-page').waitFor();await page.locator('.rc').waitFor();await page.locator('.rc').scrollIntoViewIfNeeded();};
 try{
  await page.goto(origin+'/preview-org/meetings');await open('ready');
  await shot('record-1-ready.png');
  await page.locator('.rc-chips').getByRole('button',{name:'తెలుగు'}).click();await page.locator('.rc-seg').nth(1).getByRole('button',{name:'30 days'}).click();
  assert.match(await page.locator('.rc-hint').nth(2).innerText(),/MP3/);
  await page.locator('.rc-seg').nth(1).getByRole('button',{name:'Off'}).click();
  await open('recording');await shot('record-2-recording.png');
  await open('done');await shot('record-3-done.png');
  await page.locator('.rc-tick').nth(3).click();assert.match(await page.locator('.rc-actions .btn-primary').innerText(),/Add 3/);
  await page.locator('.rc-actions .btn-primary').click();assert.match(await page.locator('.rc-actions .btn-primary').innerText(),/Added 3/);
  await page.setViewportSize({width:390,height:844});await open('done');await fitsPhone(page,'record done',assert);await shot('record-4-phone.png');
  await open('recording');await fitsPhone(page,'record live',assert);await shot('record-5-phone-live.png');
  await page.evaluate(()=>{localStorage.setItem('pm_theme','dark');});await page.setViewportSize({width:1440,height:1000});await open('done');await shot('record-6-dark.png');

  // The real panel (no preview flag): a fake microphone and fake shared sound, pieces uploaded in order, minutes, and only ticked items become tasks.
  await page.setViewportSize({width:1440,height:1000});
  await page.addInitScript(()=>{
   const fake=()=>{const c=new AudioContext();const o=c.createOscillator();const d=c.createMediaStreamDestination();o.frequency.value=330;o.connect(d);o.start();return d.stream;};
   navigator.mediaDevices.getUserMedia=async()=>fake();navigator.mediaDevices.getDisplayMedia=async()=>fake();
  });
  await page.evaluate(()=>{sessionStorage.setItem('pm_no_record_preview','1');localStorage.removeItem('pm_record_preview');localStorage.removeItem('pm_record_state');localStorage.setItem('pm_theme','light');});
  await page.goto(origin+`/preview-org/meetings?open=p:${ids.ours}`);await page.getByTestId('meeting-page').waitFor();await page.locator('.rc').waitFor();
  await page.locator('.rc-seg').first().getByRole('button',{name:'Mic only'}).click();
  await page.getByRole('button',{name:'Start recording'}).click();await page.locator('.rc-clock').waitFor();
  await page.waitForTimeout(3500);
  await page.getByRole('button',{name:'Stop'}).click();
  await page.locator('.rc-sug').waitFor();
  assert.ok(segments>=1,'pieces were uploaded');
  assert.match(await page.locator('.rc-sum').innerText(),/release deck/i);
  assert.equal(await page.locator('.rc-sug li').count(),2);
  await page.locator('.rc-tick').nth(0).click();
  await page.locator('.rc-actions .btn-primary').click();
  await page.waitForFunction(()=>/Added 1/.test(document.querySelector('.rc-actions .btn-primary')?.textContent||''));
  assert.deepEqual(writes.filter(w=>w.ep.endsWith('/tasks')).at(-1).b,{items:[1]});
  await shot('record-7-real-done.png');
  checks.push('real-engine');
  checks.push('record-states');
 }catch(e){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error('page errors:',errors);throw e;}
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,pageErrors:errors,artifacts:out}));
}finally{await browser.close();}
