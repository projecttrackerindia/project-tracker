import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appCsp } from './lib/csp.mjs';
const dist=path.resolve('dist');
const nginx=await fs.readFile('nginx.conf','utf8');
const csp = await appCsp();
const origin='https://projecttracker-preview.test';
const artifacts=path.resolve(process.env.PM_UI_ARTIFACTS||'test-results/enterprise-ui');
await fs.mkdir(artifacts,{recursive:true});
const artifact=name=>path.join(artifacts,name);

let calendarDenied=false;let calendarReads=0;let calendarChecks=0;let calendarsEnabled=true;const calendarContext='c'.repeat(64);
let attachmentReads=0;let attachmentDownloads=0;let inboxReads=0;let inboxEnabled=true;let summaryCalls=0;const summaryReceipts=new Map();const inboxSourceHash="a".repeat(64);
let inboxBody='Please review the delivery milestones. <script>window.inboxUnsafe=true</script>';
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Preview User',email:'preview@example.test',emailVerified:true,isPlatformAdmin:false,timeZone:'Asia/Kolkata'};
const workspace={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Organization',type:'Organization',role:'Owner',planCode:'BUSINESS',description:null,memberCount:2};
const context={user,workspaces:[workspace],fingerprint:'preview',pendingConsent:[],current:{...workspace,permissions:['work.view','work.create','work.edit','workflow.manage','reports.view'],modules:{work:3,projects:3,reports:3,ai:0,chat:0,time:0,people:3,documents:3,calendar:3},plan:{code:'BUSINESS',name:'Business',status:'Active',trialEnd:null,periodEnd:null,cancelAtPeriodEnd:false,downgraded:false},entitlements:{AUTOMATION:1,RESUME_TEMPLATES:8}}};
const catalog=JSON.parse(await fs.readFile(new URL('./fixtures/resume-designs.json',import.meta.url),'utf8'));const templates=catalog.slice(0,8);
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
const errors=[];const checks=[];
try {
 const ctx=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){await route.abort();return;}
  if(url.pathname.endsWith('/avatar')){await route.fulfill({status:404,contentType:'application/json',body:'{"message":"No synthetic profile photo"}'});return;}
  if(!url.pathname.startsWith('/api/')){
   const filename=path.resolve(dist,url.pathname.startsWith('/assets/')?url.pathname.slice(1):'index.html');
   if(!filename.startsWith(dist+path.sep))throw new Error('Static path escapes');
   const ext=path.extname(filename);
   const type={'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'}[ext]||'application/octet-stream';
   await route.fulfill({status:200,contentType:type,body:await fs.readFile(filename),headers:ext==='.html'?{'content-security-policy':csp}:{}});return;
  }
  if(url.pathname==='/api/v1/me/inbox/attachments/download'){
   assert.equal(route.request().method(),'GET');assert.equal(url.searchParams.get('token'),'synthetic-private-file-token');attachmentDownloads++;
   await route.fulfill({status:200,contentType:'application/octet-stream',headers:{'content-disposition':'attachment; filename="review-notes.txt"','x-content-type-options':'nosniff'},body:'Synthetic private attachment content'});return;
  }
  let data=[];
  if(url.pathname==='/api/v1/me/inbox/summaries'&&route.request().method()==='POST'){
   const b=route.request().postDataJSON();assert.equal(b.confirmed,true);assert.equal(b.sourceHash,inboxSourceHash);assert.equal(b.credits,1);assert.match(b.operationId,/^[0-9a-f-]{36}$/);
   const id=b.provider==='google'?'1001':'message1';assert.equal(b.messageId,id);
   if(!summaryReceipts.has(b.operationId)){
    summaryCalls++;
    summaryReceipts.set(b.operationId,{...b,status:'completed',createdAt:'2026-10-11T08:00:00Z',expiresAt:'2026-10-12T08:00:00Z',model:'synthetic-preview',sourceChanged:false,points:[{text:'The integration review is scheduled for Friday, 16 October.',messageId:id,quote:'The integration review is scheduled for Friday, 16 October.'},{text:'Outstanding blockers are requested before the review.',messageId:id,quote:'Could you share the outstanding blockers before the review?'}]});
   }
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:summaryReceipts.get(b.operationId)})});return;
  }
  if(url.pathname==='/api/v1/me/microsoft-calendars/availability'){
   assert.equal(route.request().method(),'POST');
   if(calendarDenied){await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({message:'Calendar access was revoked.',errors:[{code:'NOT_A_MEMBER',message:'Calendar access was revoked.'}]})});return;}
   const b=route.request().postDataJSON();assert.equal(b.accessContext,calendarContext);assert.deepEqual(b.calendarIds,['own1','own2']);calendarChecks++;
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:{account:'preview@outlook.example.test',accessContext:calendarContext,calendarIds:b.calendarIds,startUtc:b.start,endUtc:b.end,busy:[{startUtc:b.start,endUtc:new Date(new Date(b.start).getTime()+1800000).toISOString()}],checkedAt:'2026-10-12T08:00:00Z',scope:'Selected own Outlook calendars only. Other calendars and attendees are not checked. Availability can change after this read.'}})});return;
  }
  if(!url.pathname.endsWith('/auth/refresh'))assert.equal(route.request().method(),'GET', 'Unexpected mutation in synthetic UI check');
  if(url.pathname.endsWith('/auth/refresh'))data={accessToken:`x.${Buffer.from(JSON.stringify({wid:workspace.id,exp:4102444800})).toString('base64url')}.x`,expiresAt:'2099-01-01T00:00:00Z',user,refreshToken:null};
  else if(url.pathname==='/api/v1/me')data=context;
  else if(url.pathname.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
  else if(url.pathname.endsWith('/me/connected-accounts'))data={google:{connected:true,configured:true,googleEmail:'preview@gmail.example.test',connectedAt:'2026-10-11T08:00:00Z',lastError:null,calendarAccess:true,mailEnabled:false,mailSendAccess:false,inboxEnabled,inboxAccess:true,transcriptAccess:false},
   microsoft:{enabled:true,configured:true,connected:true,email:'preview@outlook.example.test',mailSendAccess:true,inboxEnabled,inboxAccess:true,calendarsEnabled,calendarAccess:true,connectedAt:'2026-10-11T08:00:00Z',meetingsEnabled:true,meetingsAccess:false},
   slack:{available:true,workspaceConnected:true,teamName:'Preview',linked:false,name:null,messages:'off',problem:null},gitHub:{available:true,linked:false,email:null,appInstalled:false},
   meetingService:'auto',meetings:{preference:'auto',provider:'google',name:'Google Meet',reason:'Your Google account is connected, so meetings go to Google Calendar with a Meet link.',googleReady:true,microsoftReady:false,ownCallsReady:true},meetingProblem:null};
  else if(url.pathname.endsWith('/integrations/google/status'))data={connected:true,googleEmail:'preview@gmail.example.test',connectedAt:'2026-10-11T08:00:00Z',lastError:null,calendarAccess:true,mailEnabled:false,mailSendAccess:false,inboxEnabled,inboxAccess:true};
  else if(url.pathname.endsWith('/integrations/microsoft/status'))data={enabled:true,configured:true,connected:true,email:'preview@outlook.example.test',mailSendAccess:true,inboxEnabled,inboxAccess:true,calendarsEnabled,calendarAccess:true,connectedAt:'2026-10-11T08:00:00Z'};
  else if(url.pathname==='/api/v1/me/microsoft-calendars'){calendarReads++;data={account:'preview@outlook.example.test',accessContext:calendarContext,calendars:[{id:'own1',name:'Primary schedule',isDefault:true},{id:'own2',name:'Focus time',isDefault:false}],truncated:false};}
  else if(url.pathname==='/api/v1/me/inbox/attachments'){attachmentReads++;data={files:[{name:'review-notes.txt',size:36,mediaType:'text/plain',inline:false,downloadToken:'synthetic-private-file-token',unavailableReason:null}],truncated:false,maxDownloadBytes:2097152};}
  else if(url.pathname==='/api/v1/me/inbox/summaries/options')data={available:true,credits:1,maxSourceCharacters:18000,retentionHours:24};
  else if(url.pathname==='/api/v1/me/inbox/summaries')data=[...summaryReceipts.values()];
  else if(url.pathname.startsWith('/api/v1/me/inbox/summaries/'))data=summaryReceipts.get(url.pathname.split('/').at(-1));
  else if(url.pathname==='/api/v1/me/inbox'||url.pathname==='/api/v1/me/inbox/thread'){
   inboxReads++;
   const provider=url.searchParams.get('provider');
   const account=provider==='google'?'preview@gmail.example.test':'preview@outlook.example.test';
   const message={id:provider==='google'?'1001':'message1',threadId:'conversation1',subject:'Project delivery review',sender:'reviewer@example.test',receivedAt:'2026-10-11T08:00:00Z',unread:true,hasAttachments:true,body:url.pathname.endsWith('/thread')?inboxBody:null,bodyTruncated:false};
   data=url.pathname.endsWith('/thread')?{provider,account,threadId:'conversation1',messages:[message],truncated:false,sourceHash:inboxSourceHash,accessContext:inboxSourceHash}:{provider,account,messages:[message],cursor:null};
  }
  else if(url.pathname.endsWith('/resumes/options'))data={templates,catalog,templateLimit:8,aiAvailable:false,aiCredits:0,cleanCheckoutEnabled:false,cleanPricePaise:4900,cleanTaxPaise:0,taxLabel:''};
  else if(url.pathname.endsWith('/me/certifications'))data=[{id:'00000000-0000-0000-0000-000000000003',name:'Project Management Certification',issuer:'Preview Institute',issuedOn:'2025-01-01',expiresOn:'2027-01-01',credentialId:null,verificationUrl:null,showBadge:false,archived:false,version:1,verificationStatus:'self-reported',expiryReminders:true,hasAttachment:false,attachmentFormat:null}];
  else if(url.pathname.includes('/unread')||url.pathname.includes('/counts'))data={count:0,total:0};
  else if(url.pathname==='/api/v1/timer')data=null;
  else if(url.pathname.endsWith('/workspace/logo'))data={hasLogo:false};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});
 });
 await ctx.addInitScript(()=>localStorage.setItem('pm_alerts_prompt','1'));
 let page=await ctx.newPage();
 const attachErrors=()=>page.on('pageerror',e=>errors.push(e.message));
 attachErrors();
 async function capture(name,path,selector,width,height){
  // A fresh page avoids shell remounts racing a phone-to-desktop media-query change.
  await page.close();page=await ctx.newPage();attachErrors();
  await page.setViewportSize({width,height});
  await page.goto(origin+path);
  try { await page.locator(selector).waitFor({state:'visible',timeout:15000}); }
  catch(e) { await fs.writeFile(artifact('browser-failure.json'),JSON.stringify({path,pageErrors:errors,body:await page.locator('body').innerText()},null,2));await page.screenshot({path:artifact('browser-failure.png'),fullPage:true});throw e; }
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:artifact(name+'.png'),fullPage:true,animations:"disabled"});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
  checks.push({name,overflow});
 }
 // Notification preferences moved into the Notification Center: the old address must land there, and the center must render its sections.
 await capture('account-notifications-redirect','/account/notifications','.nc-page',1440,1000);
 assert.match(new URL(page.url()).pathname,/\/notifications\/preferences$/,'/account/notifications must open the Notification Center');
 assert.equal(await page.getByRole('navigation',{name:'Notification Center sections'}).getByRole('link').count(),4);
 for(const section of ['','/security','/mobile','/integrations','/resumes']) {
  await capture('account-navigation-'+(section.slice(1)||'profile'),'/account'+section,'.section-layout-wide',1440,1000);
  const nav=page.getByRole('navigation',{name:'My account sections'});assert.equal(await nav.getByRole('link').count(),5);   // Profile, Sign-in, Mobile app, Connected accounts, Resume studio (notifications live behind the bell)
  const rows=await nav.getByRole('link').evaluateAll(links=>links.map(link=>Math.round(link.getBoundingClientRect().top)));
  assert.ok(rows.every(top=>Math.abs(top-rows[0])<=1),'All account sections use the same horizontal navigation');
 }
 checks.push({name:'six-account-sections-horizontal-navigation',passed:true});
 await capture('resume-current-desktop','/account/resumes','.resume-builder',1440,1000);
 await capture('resume-current-mobile','/account/resumes','.resume-builder',390,844);
 const fileInput=page.locator('.resume-upload input[type=file]').first();
 await fileInput.focus();
 checks.push({name:'resume-upload-keyboard-focus',focused:await fileInput.evaluate(el=>document.activeElement===el)});
 await capture('resume-final-desktop','/account/resumes','.resume-builder',1440,1000);
 // Every design appears once, as a drawing of its page: the eight in the plan can be picked, the other four carry a lock.
 assert.equal(catalog.length,12);
 const designs=page.getByRole('group',{name:'Choose resume design'}).getByRole('button');
 assert.equal(await designs.count(),catalog.length);
 assert.equal(await page.getByRole('group',{name:'Choose resume design'}).locator('[aria-disabled=true]').count(),catalog.length-templates.length);
 assert.equal(await page.locator('.resume-catalog-card, .resume-template-card').count(),0,'No second picker or library dialog');
 assert.equal(await page.getByRole('combobox',{name:/Template/}).count(),0,'No dropdown repeating the designs');
 await designs.nth(1).focus();await designs.nth(1).press('Enter');
 assert.equal(await designs.nth(1).getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('.resume-paper.ruled:not(.centered):not(.supplied)').count(),1,'Modern: one column, left-aligned, with rules');
 const lockedDesign=page.getByRole('button',{name:'Sidebar Plum, not in your plan'});
 await lockedDesign.evaluate(el=>el.click());assert.equal(await lockedDesign.getAttribute('aria-pressed'),'false');assert.equal(await designs.nth(1).getAttribute('aria-pressed'),'true','A locked design does not change the page');
 await page.getByRole('button',{name:'Sidebar Navy',exact:true}).click();
 assert.equal(await page.locator('.resume-paper.supplied .resume-paper-sidebar').count(),1);
 assert.match(await page.locator('.resume-designs-head').innerText(),/Sidebar Navy/);
 // The page follows the export's margins: Compact (30pt) is tighter than Minimal (60pt).
 const pad=async name=>{await page.getByRole('button',{name,exact:true}).click();return page.locator('.resume-paper').evaluate(el=>parseFloat(getComputedStyle(el).paddingLeft));};
 assert.ok(await pad('Compact')<await pad('Minimal'),'Margins differ between designs');
 checks.push({name:'resume-12-designs-one-picker-plan-lock-and-margins',passed:true});
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.evaluate(()=>{localStorage.setItem('pm_theme','dark');document.documentElement.setAttribute('data-theme','dark');});
 await page.screenshot({path:artifact('resume-final-dark-desktop.png'),fullPage:true,animations:'disabled'});
 checks.push({name:'dark-theme-and-reduced-motion',passed:true});
 await page.goto(origin+'/calendar');await page.locator('.outlook-availability').waitFor({state:'visible'});
 assert.equal(calendarReads,0,'Outlook calendar inventory must not load automatically');assert.equal(calendarChecks,0);
 await page.getByRole('button',{name:'Load my Outlook calendars',exact:true}).click();
 await page.getByRole('checkbox',{name:'Focus time',exact:true}).waitFor({state:'visible'});assert.equal(calendarReads,1);assert.equal(calendarChecks,0);
 await page.getByRole('checkbox',{name:'Focus time',exact:true}).check();
 await page.getByLabel('Outlook window start').fill('2026-10-14T10:00');await page.getByLabel('Outlook window end').fill('2026-10-14T12:00');
 await page.getByRole('button',{name:'Check selected calendars',exact:true}).click();await page.locator('.outlook-result').waitFor({state:'visible'});
 assert.equal(calendarChecks,1);assert.equal(await page.locator('.outlook-result li').count(),1);assert.match(await page.locator('.outlook-result').textContent(),/Other calendars and attendees are not checked/);
 assert.match(await page.locator('.outlook-result').textContent(),/10:00/);assert.equal(calendarReads,1);
 await page.setViewportSize({width:390,height:1200});await page.locator('.outlook-availability').screenshot({path:artifact('outlook-availability-light-mobile.png'),animations:'disabled',style:'.m-tabs{visibility:hidden}'});
 checks.push({name:'outlook-calendar-explicit-load-multiple-selection-local-time-read-only-check-mobile',passed:true,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
 await page.setViewportSize({width:1440,height:1400});await page.goto(origin+'/calendar');await page.locator('.outlook-availability').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Load my Outlook calendars',exact:true}).click();await page.getByRole('checkbox',{name:'Focus time',exact:true}).waitFor({state:'visible'});await page.getByRole('checkbox',{name:'Focus time',exact:true}).check();
 await page.getByLabel('Outlook window start').fill('2026-10-14T10:00');await page.getByLabel('Outlook window end').fill('2026-10-14T12:00');await page.getByRole('button',{name:'Check selected calendars',exact:true}).click();await page.locator('.outlook-result').waitFor({state:'visible'});
 await page.locator('.outlook-availability').screenshot({path:artifact('outlook-availability-light-desktop.png'),animations:'disabled'});
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.setAttribute('data-theme','dark');});await page.locator('.outlook-availability').screenshot({path:artifact('outlook-availability-dark-desktop.png'),animations:'disabled'});
 calendarDenied=true;await page.getByRole('button',{name:'Check selected calendars',exact:true}).click();await page.locator('.outlook-error').waitFor({state:'visible'});
 assert.equal(await page.locator('.outlook-planning-grid').count(),0);assert.equal(await page.locator('.outlook-result').count(),0);
 checks.push({name:'outlook-revoked-access-clears-calendar-names-and-busy-results',passed:true});
 const beforeCalendarDisabled=calendarReads;calendarsEnabled=false;await page.reload();await page.locator('.cal-filters').waitFor({state:'visible'});await page.waitForTimeout(400);
 // Switched off by the administrator: the calendar shows no Outlook panel at all (no "awaiting setup" box).
 assert.equal(await page.locator('.outlook-availability').count(),0);
 assert.equal(await page.locator('.outlook-result').count(),0);assert.equal(await page.locator('.outlook-planning-grid').count(),0);assert.equal(calendarReads,beforeCalendarDisabled);
 checks.push({name:'outlook-calendar-disabled-gate-clears-private-state-without-reads',passed:true});
 // Regression checks for spacious writing, adaptive layout and same-browser native connection starts.
 for (const width of [320,390,820,1280,1440,1920]) {
  await capture(`resume-responsive-${width}`,'/account/resumes','.resume-builder',width,1000);
  const before=await page.locator('.resume-editor').evaluate(el=>el.getBoundingClientRect().width);
  await page.getByRole('group',{name:'Resume workspace view'}).getByRole('button',{name:'Edit',exact:true}).click();
  assert.equal(await page.locator('.resume-preview-panel').isVisible(),false);
  const after=await page.locator('.resume-editor').evaluate(el=>el.getBoundingClientRect().width);
  if(width>=1440)assert.ok(after>=Math.min(before+150,860),'Edit mode gives the editor the full reading width');
  const summary=page.getByLabel('Profile summary');
  assert.ok(await summary.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))>=(width<600?16:15));
  await page.getByLabel('Full name').fill('Asha Patel');
  await page.getByLabel('Professional headline').fill('Senior Product & Delivery Manager');
  await page.getByLabel('Contact details').fill('Bengaluru, India · asha@example.test');
  await summary.fill('I turn complex ideas into useful products. Over eight years, I have led cross-functional teams and helped ambitious businesses grow with clarity.');
  await page.locator('.resume-section-editor textarea').first().fill('Senior Product Manager · Northstar Studio\n2022 – Present\n\nLed a team of 12 across design, engineering and customer success.\nReduced release lead time by 30% through clearer discovery and planning.');
  if([390,1440].includes(width)) {
   await summary.scrollIntoViewIfNeeded();await page.screenshot({path:artifact(`resume-writing-${width}.png`),animations:'disabled'});
  }
  await page.getByRole('group',{name:'Resume workspace view'}).getByRole('button',{name:'Preview',exact:true}).click();
  assert.equal(await page.locator('.resume-editor').isVisible(),false);
  await page.getByRole('button',{name:'Sidebar Navy',exact:true}).click();
  assert.equal(await page.locator('.resume-paper.centered.supplied').count(),1);
  assert.match(await page.locator('.resume-paper').innerText(),/cross-functional teams/);
  if([390,1440].includes(width)) {
   await page.locator('.resume-paper').scrollIntoViewIfNeeded();await page.screenshot({path:artifact(`resume-preview-${width}.png`),animations:'disabled'});
  }
  checks.push({name:`resume-full-size-edit-preview-${width}`,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
 }
 await capture('connected-accounts-desktop','/account/integrations','.ca-grid',1440,1000);
 // Each use of an account is its own switch: Google Calendar and inbox on, transcripts off; Outlook mail, inbox and availability on, Teams off.
 assert.equal(await page.locator('.ca-toggle.on').count(),5);
 assert.equal(await page.getByRole('radio',{name:/Automatic/}).getAttribute('aria-checked'),'true');
 assert.equal(await page.locator('.personal-inbox').count(),0,'Mail lives in Mailbox, not in settings');
 await capture('connected-accounts-mobile','/account/integrations','.ca-grid',390,844);
 await page.close();page=await ctx.newPage();attachErrors();
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'userAgent',{value:'Mozilla/5.0 ProjectTrackerDesktop/1.0.0'});
  window.browserConnectionOpens=0;window.browserConnectionSlugs=[];
  window.ptDesktop={openConnectedAccounts:(slug)=>{window.browserConnectionOpens++;window.browserConnectionSlugs.push(slug);}};
 });
 await page.goto(origin+'/account/integrations');
 await page.getByRole('button',{name:'Turn on Meeting transcripts',exact:true}).click();
 await page.getByRole('button',{name:'Turn on Outlook calendar and Teams meetings',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.browserConnectionOpens),2);
 assert.deepEqual(await page.evaluate(()=>window.browserConnectionSlugs),['preview-org','preview-org']);
 checks.push({name:'electron-starts-google-and-microsoft-in-system-browser',passed:true});
 const result={fixture:'Synthetic browser responses only; no live APIs, model calls, payments or external sends',checks,pageErrors:errors};
 await fs.writeFile(artifact('results.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
 assert.deepEqual(errors,[]);assert.ok(checks.every(c=>!c.overflow&&c.focused!==false));
} finally {await browser.close();}
