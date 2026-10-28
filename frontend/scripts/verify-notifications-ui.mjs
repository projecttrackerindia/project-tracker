import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Notification Center inbox: two lanes (Needs you / Updates) and Archived, notices about the same thing bundled into one row, archive with
// undo, mute a kind with undo, "Why am I getting this", clear read, and the phone layout. Built frontend with synthetic API fixtures only;
// notification text must render as literal text.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/notifications-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const N=(id,type,title,mins,link,isRead,needsYou,body=null,actions=['snooze'])=>({id,type,title,body,link,isRead,createdAt:iso(-mins),browser:false,needsYou,archived:false,actions});
const needs=[
 N('n1','TaskAssigned','You were assigned "Fix portal login"',5,'/tasks/t1',false,true,'Payments Core · due Friday',['done','reply','snooze']),
 N('n2','Mention','Ravi mentioned you on "Fix portal login"',9,'/tasks/t1',false,true),
 N('n3','Approval','Approve leave for Meena <img src=x onerror="window.ncUnsafe=1">',30,'/approvals/a1',true,true,null,['approve','reject','snooze']),
];
const info=[N('n4','Comment','New comment on "Release notes"',40,'/tasks/t2',true,false,'Looks good to me')];
const snoozedList=[{...N('n6','Comment','Comment on "Budget review"',600,'/tasks/t9',false,false),snoozedUntil:iso(240),actions:[]}];
const archived=[{...N('n5','Comment','Old comment on "Budget"',3000,'/tasks/t3',true,false),archived:true}];
let prefs=[
 {type:'TaskAssigned',label:'Assigned to me',description:'When work is assigned to you',inApp:true,email:true,browser:true,locked:false},
 {type:'Reminder',label:'Your reminders',description:'Reminders you set',inApp:true,email:false,browser:true,locked:false},
 {type:'Security',label:'Security alerts',description:'Sign-ins and account changes',inApp:true,email:true,browser:true,locked:true},
];
// Added later in the run: a follow-up reminder for an unanswered question (with its drafted nudge) and reminders offered from what was said.
let extra=[],suggestions=[];
const followUp=N('n7','Reminder',"Ravi Kumar hasn't replied to your question",5,'/chat/c1',false,true,'You asked on Wed 21 Oct: “Can you share the deck?”\nSuggested nudge: Hi Ravi, just following up on my question above. Could you take a look when you get a moment?',['reply','snooze']);
const offer={id:'s1',title:'Send the estimate',fireAt:iso(60*20),sourceKind:'chat',link:'/chat/c1',quote:"Sure, I'll send the estimate tomorrow.",createdAt:iso(-1)};
const writes=[],errors=[],checks=[];
let remSettings={workDays:[1,2,3,4,5],workStart:'09:00',workEnd:'18:00',quietStart:'21:00',quietEnd:'08:00',defaultTime:'09:00',autoEnabled:true,dueLeads:[1,0],overdueSteps:[1,3,7],dailyAutoLimit:12,briefingEnabled:true,briefingTime:'08:30',followDeviceTimeZone:false,muteNudges:false,timeZone:'Asia/Kolkata',digestTime:null};
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async()=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');});
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[];
   const p=url.searchParams;
   if(/^\/api\/v1\/notifications\/n\d\/(archive|unarchive|read)$/.test(ep)&&method==='POST'){writes.push({ep});await route.fulfill({status:204,body:''});return;}
   else if(/^\/api\/v1\/notifications\/n\d\/act$/.test(ep)&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={message:b.action==='snooze'?'Snoozed.':'Done.',archived:['done','approve','reject'].includes(b.action)};}
   else if(ep==='/api/v1/notifications/archive-read'&&method==='POST'){writes.push({ep});data={archived:2};}
   else if(ep==='/api/v1/notifications/read-all'&&method==='POST'){writes.push({ep});data=null;}
   else if(ep==='/api/v1/me/notification-preferences'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});prefs=prefs.map(x=>{const c=b.items.find(i=>i.type===x.type);return c?{...x,...c}:x;});data=prefs;}
   else if(/^\/api\/v1\/reminders\/suggestions\/s\d\/(accept|dismiss)$/.test(ep)&&method==='POST'){writes.push({ep});suggestions=[];data={id:'r1',title:offer.title,state:'Scheduled',nextFireAt:offer.fireAt};}
   else if(ep==='/api/v1/reminders/settings'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});remSettings=b;data=b;}
   else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
   else if(ep==='/api/v1/reminders'&&method==='GET'){
    // One reminder that went off and waits for the person, one coming up.
    const R=(id,title,state,extra)=>({id,source:'Personal',state,title,note:null,targetType:'None',targetId:null,targetKey:null,targetTitle:null,link:null,timeZone:'Asia/Kolkata',localAt:null,anchorDays:null,anchorTime:null,recurrence:null,recurrenceText:null,onlyIfOpen:false,exact:false,nextFireAt:null,isSnoozed:false,snoozeCount:0,fireCount:0,lastFiredAt:null,quiet:false,completedAt:null,seriesId:null,from:null,for:null,canEdit:true,createdAt:iso(-600),...extra});
    data={open:[R('rm1','Call the bank about the EMI file','Fired',{lastFiredAt:iso(-20),fireCount:1}),R('rm2','Submit my timesheet','Scheduled',{nextFireAt:iso(60*30)})],completed:[],sent:[],counts:{},limits:{open:100,recurring:20,openUsed:2,recurringUsed:0}};
   }
   else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','tasks.view','org.manage','reports.view','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
    else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
    else if(ep==='/api/v1/notifications/counts')data={unread:2,needsYou:2,forInfo:0,snoozed:1};
    else if(ep==='/api/v1/notifications'){
     const list=p.get('archived')==='true'?archived:p.get('lane')==='snoozed'?snoozedList:p.get('lane')==='info'?info:p.get('lane')==='needs'?[...extra,...needs]:[...extra,...needs,...info];
     const it=p.get('unreadOnly')==='true'?list.filter(n=>!n.isRead):list;
     data={items:it,page:1,pageSize:20,totalPages:1,totalItems:it.length};
    }
    else if(ep==='/api/v1/me/notification-preferences')data=prefs;
    else if(ep==='/api/v1/me/whatsapp-contact/notification-preferences')data={version:3,optedIn:true,canEnable:true,taskAssignments:true,overdue:false,supportUpdates:false,reminders:true,approvals:false,timeZone:'Asia/Kolkata',quietStartMinutes:1320,quietEndMinutes:480,requiredConsentVersion:'whatsapp-notifications-v1',consentAt:iso(-60),expiresAt:iso(60*24*20),deliveryEnabled:true};
    else if(ep==='/api/v1/me/whatsapp-contact')data={status:'verified',phone:'+91 98•••••210'};
    else if(ep==='/api/v1/reminders/settings')data=remSettings;
    else if(ep==='/api/v1/reminders/suggestions')data=suggestions;
    else if(ep==='/api/v1/reminders')data={open:[],completed:[],sent:[],counts:{now:0,today:0,upcoming:0,completed:0},limits:{open:500,recurring:100,openUsed:0,recurringUsed:0}};
    else if(ep==='/api/v1/reminders/insights')data={doneThisWeek:0,firedThisWeek:0,onTimePercent:0,usualTime:null,snoozedOften:[]};
    else if(ep==='/api/v1/reminders/counts')data={now:0,today:0,upcoming:0,completed:0};
    else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
    else if(ep==='/api/v1/timer')data=null;
    else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
    else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
    else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
    else if(ep==='/api/v1/chat/projects/unread')data=[];
    else if(ep.includes('/counts')||ep.includes('/unread'))data={count:2,total:0};
   }
   await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
  });
  return ctx;};
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(300);await page.screenshot({path:path.join(out,name)});};
 const waitWrite=async(test)=>{for(let i=0;i<40&&!writes.some(test);i++)await new Promise(r=>setTimeout(r,100));return writes.find(test);};
 const ctx=await make();const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 await page.goto(origin+'/preview-org/notifications');await page.locator('.nc-item').first().waitFor();

 // "Needs you" opens first with its count; the two notices about the same task are one row with "+1" behind it.
 const tab=(name)=>page.getByRole('tab',{name:new RegExp(`^${name}`)});
 assert.equal(await tab('Needs you').getAttribute('aria-selected'),'true');
 assert.match(await tab('Needs you').innerText(),/2/);
 assert.equal(await page.locator('.nc-item').count(),2,'n1 and n2 bundle into one row');
 assert.match(await page.locator('.nc-item').first().innerText(),/assigned "Fix portal login"/);
 await page.locator('.nc-more').first().click();
 assert.match(await page.locator('.nc-sub').innerText(),/Ravi mentioned you/);
 // The title is text, never markup.
 assert.match(await page.locator('.nc-item').nth(1).innerText(),/<img src=x/);
 assert.equal(await page.evaluate(()=>window.ncUnsafe),undefined);
 checks.push('lanes-and-bundles');
 await shot(page,'inbox-desktop.png');

 // Why am I getting this?
 const first=page.locator('.nc-item').first();
 await first.hover();await first.locator('.nc-menu > summary').click();
 await page.getByRole('menuitem',{name:'Why am I getting this?'}).click();
 assert.match(await page.locator('.nc-why').innerText(),/assignee/);
 checks.push('why');

 // Archive the bundle: both notices are archived; Undo brings both back.
 await first.hover();await first.getByRole('button',{name:'Archive'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n1/archive'));
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n2/archive'));
 await page.locator('.toast-action',{hasText:'Undo'}).first().click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n1/unarchive'));
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n2/unarchive'));
 checks.push('archive-undo');

 // Mute this kind: the app and push go off for "Assigned to me" (email stays); Undo restores it.
 await first.hover();await first.locator('.nc-menu > summary').click();
 await page.getByRole('menuitem',{name:'Mute this kind'}).click();
 const muted=await waitWrite(w=>w.ep==='/api/v1/me/notification-preferences');
 assert.deepEqual(muted.b.items,[{type:'TaskAssigned',inApp:false,email:true,browser:false}]);
 await page.locator('.toast-action',{hasText:'Undo'}).first().click();
 await waitWrite(w=>w.ep==='/api/v1/me/notification-preferences'&&w.b.items[0].inApp===true);
 assert.deepEqual(writes.filter(w=>w.ep==='/api/v1/me/notification-preferences').at(-1).b.items,[{type:'TaskAssigned',inApp:true,email:true,browser:true}]);
 checks.push('mute-undo');

 // Mark read on the bundle reads every unread notice in it.
 await first.hover();await first.getByRole('button',{name:'Mark as read'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n1/read'));
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n2/read'));
 checks.push('read-bundle');

 // Updates, then Clear read.
 await tab('Updates').click();
 await page.locator('.nc-item',{hasText:'Release notes'}).waitFor();
 assert.equal(await page.locator('.nc-item').count(),1);
 await page.getByRole('button',{name:'Clear read'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/archive-read'));
 checks.push('updates-clear-read');

 // Archived: move back to the inbox.
 await tab('Archived').click();
 await page.locator('.nc-item',{hasText:'Budget'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Clear read'}).count(),0);
 const old=page.locator('.nc-item').first();await old.hover();await old.getByRole('button',{name:'Move to inbox'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n5/unarchive'));
 checks.push('archived');

 // Act in place: mark done, reply and approve right from the inbox, with the same requests the server checks.
 const act=(id,test)=>waitWrite(w=>w.ep===`/api/v1/notifications/${id}/act`&&test(w.b));
 await tab('Needs you').click();await page.locator('.nc-item',{hasText:'Fix portal login'}).first().waitFor();
 const head=page.locator('.nc-item',{hasText:'You were assigned'});
 await head.getByRole('button',{name:'Reply'}).click();await head.getByLabel('Your reply').fill('On it after lunch');
 await head.getByRole('button',{name:'Send',exact:true}).click();
 assert.ok(await act('n1',b=>b.action==='reply'&&b.text==='On it after lunch'));
 await head.getByRole('button',{name:'Mark done'}).click();assert.ok(await act('n1',b=>b.action==='done'));
 const leave=page.locator('.nc-item',{hasText:'Approve leave'});
 await leave.getByRole('button',{name:'Approve',exact:true}).click();assert.ok(await act('n3',b=>b.action==='approve'));
 await leave.getByRole('button',{name:'Send back',exact:true}).first().click();await leave.getByLabel('What should change').fill('Dates clash with the release');
 await leave.locator('.na-write').getByRole('button',{name:'Send back'}).click();
 assert.ok(await act('n3',b=>b.action==='reject'&&b.text==='Dates clash with the release'));
 checks.push('act-in-place');
 // Snooze from the menu: tomorrow 9:00 in the person's zone (Kolkata) is 03:30 UTC.
 await leave.hover();await leave.locator('.nc-menu > summary').click();await page.getByRole('menuitem',{name:'Tomorrow 9:00'}).click();
 const sz=await act('n3',b=>b.action==='snooze');assert.match(sz.b.until,/T03:30:00\.000Z$/);
 await tab('Snoozed').click();const rest=page.locator('.nc-item',{hasText:'Budget review'});await rest.waitFor();
 assert.match(await rest.innerText(),/back /);
 await rest.hover();await rest.getByRole('button',{name:'Bring back now'}).click();assert.ok(await act('n6',b=>b.action==='wake'));
 checks.push('snooze');
 // v2: no avatar badge (the Home inbox and live banners carry notifications); Settings › Notifications holds this list.
 assert.equal(await page.locator('.v2-avatar .v2-badge').count(),0,'no badge on the avatar');
 await page.goto(origin+'/preview-org/settings/notifications');await page.waitForURL(/\/settings\/notifications$/);
 await page.goBack();await page.locator('.nc-item').first().waitFor();checks.push('avatar-notifications');
 await shot(page,'inbox-actions.png');
 // Delivery: a WhatsApp column where WhatsApp is set up, showing what goes there (changed in its own consent section below).
 await page.goto(origin+'/preview-org/notifications/preferences');await page.locator('.nc-matrix').waitFor();
 await page.getByRole('columnheader',{name:/WhatsApp/}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Your reminders: WhatsApp on. Change below.'}).count(),1);
 assert.equal(await page.getByRole('button',{name:'Assigned to me: WhatsApp on. Change below.'}).count(),1);
 assert.equal(await page.locator('.nc-matrix-row',{hasText:'Security alerts'}).locator('.nc-wa-na').count(),1);
 checks.push('whatsapp-column');
 // Schedule: the daily digest.
 await page.goto(origin+'/preview-org/notifications/schedule');await page.getByRole('switch',{name:'Daily digest of updates'}).click();
 await page.locator('.nc-savebar-sticky.show').getByRole('button',{name:'Save'}).click();
 const dig=await waitWrite(w=>w.ep==='/api/v1/reminders/settings');assert.equal(dig.b.digestTime,'18:00');checks.push('digest');
 // A question nobody answered: Reply starts from the drafted nudge and sends it from the inbox.
 extra=[followUp];
 await page.goto(origin+'/preview-org/notifications');
 const owed=page.locator('.nc-item',{hasText:"hasn't replied"});await owed.waitFor();
 await owed.getByRole('button',{name:'Reply'}).click();
 assert.match(await owed.getByRole('textbox',{name:'Your reply'}).inputValue(),/^Hi Ravi, just following up/);
 await owed.getByRole('button',{name:'Send',exact:true}).click();
 const nudge=await waitWrite(w=>w.ep==='/api/v1/notifications/n7/act');assert.equal(nudge.b.action,'reply');assert.match(nudge.b.text,/^Hi Ravi/);
 checks.push('follow-up-nudge');
 extra=[];
 // Reminders offered from what was said: one tap on the Reminders page sets it.
 suggestions=[offer];
 await page.goto(origin+'/preview-org/reminders');
 const sug=page.getByRole('region',{name:'Suggested from what you said'});await sug.waitFor();
 assert.ok(await sug.getByText("You said in chat: “Sure, I'll send the estimate tomorrow.”").isVisible());
 await shot(page,'reminders-suggested.png');
 await sug.getByRole('button',{name:'Remind me'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/reminders/suggestions/s1/accept'));
 await sug.waitFor({state:'detached'});
 checks.push('suggested-reminders');
 await page.goto(origin+'/preview-org/notifications');await page.locator('.nc-item').first().waitFor();
 // Phone.
 await tab('Needs you').click();await page.locator('.nc-item',{hasText:'Fix portal login'}).first().waitFor();
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
 await fitsPhone(page,'notification inbox',assert);
 await page.goto(origin+'/preview-org/notifications/preferences');await page.locator('.nc-matrix').waitFor();await page.waitForTimeout(300);
 await fitsPhone(page,'delivery grid with WhatsApp',assert);
 await page.goto(origin+'/preview-org/notifications');await page.locator('.nc-item').first().waitFor();await page.waitForTimeout(300);
 // On a phone, reading and archiving are in the row's menu.
 const row=page.locator('.nc-item').first();
 assert.equal(await row.getByRole('button',{name:'Archive'}).isVisible(),false);
 await row.locator('.nc-menu > summary').click();
 assert.ok(await page.getByRole('menuitem',{name:'Archive'}).isVisible());
 await page.getByRole('menuitem',{name:'Archive'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n1/archive'&&writes.filter(x=>x.ep===w.ep).length>1));
 await page.waitForTimeout(5500);   // toasts gone before the picture
 await shot(page,'inbox-phone.png');
 // The phone's bell opens the Notification Centre as a full-height sheet.
 await page.locator('.m-top').getByRole('button',{name:/^Notifications/}).click();
 await page.locator('.ncx-pop.phone .ncx-card').first().waitFor();
 assert.ok((await page.locator('.ncx-pop.phone .ncx-card').count())>=1);
 const sheet=await page.locator('.ncx-pop.phone').boundingBox();assert.ok(sheet&&sheet.height>200,'the sheet is open and readable');
 await shot(page,'bell-phone.png');await page.keyboard.press('Escape');
 assert.equal(await page.locator('.ncx-pop').count(),0,'Escape closes it');
 checks.push('phone');

 assert.deepEqual(errors,[]);
 console.log('notifications ui ok:',checks.join(', '));
 await ctx.close();
}finally{await browser.close();}
