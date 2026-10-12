import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const dist=path.resolve('dist');
const nginx=await fs.readFile('nginx.conf','utf8');
const csp=nginx.match(/set \$sec_csp "([^"]+)";/)[1];
const origin='https://projecttracker-preview.test';
const artifacts=path.resolve(process.env.PM_UI_ARTIFACTS||'test-results/enterprise-ui');
await fs.mkdir(artifacts,{recursive:true});
const artifact=name=>path.join(artifacts,name);
let workflow=null;const saves=[];
let calendarDenied=false;let calendarReads=0;let calendarChecks=0;let calendarsEnabled=true;const calendarContext='c'.repeat(64);
let attachmentReads=0;let attachmentDownloads=0;let inboxReads=0;let inboxEnabled=true;let summaryCalls=0;const summaryReceipts=new Map();const inboxSourceHash="a".repeat(64);
let inboxBody='Please review the delivery milestones. <script>window.inboxUnsafe=true</script>';
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Preview User',email:'preview@example.test',emailVerified:true,isPlatformAdmin:false,timeZone:'Asia/Kolkata'};
const workspace={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Organization',type:'Organization',role:'Owner',planCode:'BUSINESS',description:null,memberCount:2};
const context={user,workspaces:[workspace],fingerprint:'preview',pendingConsent:[],current:{...workspace,permissions:['work.view','work.create','work.edit','workflow.manage','reports.view'],modules:{work:3,projects:3,reports:3,ai:0,chat:0,time:0,people:3,documents:3},plan:{code:'BUSINESS',name:'Business',status:'Active',trialEnd:null,periodEnd:null,cancelAtPeriodEnd:false,downgraded:false},entitlements:{AUTOMATION:1,RESUME_TEMPLATES:8}}};
const templates=[{id:1,name:'Essential',description:'Clean, single-column ATS layout',accent:'243247',centered:false,margin:46,rule:false,headingSize:12},{id:2,name:'Executive',description:'Centered heading and navy accents',accent:'1E3A5F',centered:true,margin:50,rule:true,headingSize:13}];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
const errors=[];const checks=[];
try {
 const ctx=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){await route.abort();return;}
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
  if(url.pathname.includes('/support/workflows')&&route.request().method()!=='GET'){
   assert.ok(['POST','PUT'].includes(route.request().method()));
   const body=route.request().postDataJSON();
   assert.equal(body.version,workflow?.version??0,'Save must use the reviewed workflow version');
   assert.deepEqual(Object.keys(body).sort(),['graph','name','version']);
   assert.ok(body.graph.nodes.every(n=>!('measured' in n)&&!('selected' in n)&&!('dimensions' in n)));
   saves.push(structuredClone(body));
   workflow={id:'00000000-0000-0000-0000-000000000005',...body,enabled:false,publishedRevisionId:null,version:(workflow?.version??0)+1,revisions:[]};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:workflow})});return;
  }
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
  if(url.pathname.endsWith('/auth/refresh'))data={accessToken:'synthetic-preview-token',expiresAt:'2099-01-01T00:00:00Z',user,refreshToken:null};
  else if(url.pathname==='/api/v1/me')data=context;
  else if(url.pathname.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
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
  else if(url.pathname.endsWith('/resumes/options'))data={templates,templateLimit:2,aiAvailable:false,aiCredits:0,cleanCheckoutEnabled:false,cleanPricePaise:4900,cleanTaxPaise:0,taxLabel:''};
  else if(url.pathname.endsWith('/me/certifications'))data=[{id:'00000000-0000-0000-0000-000000000003',name:'Project Management Certification',issuer:'Preview Institute',issuedOn:'2025-01-01',expiresOn:'2027-01-01',credentialId:null,verificationUrl:null,showBadge:false,archived:false,version:1,verificationStatus:'self-reported',expiryReminders:true,hasAttachment:false,attachmentFormat:null}];
  else if(url.pathname.endsWith('/support/workflows'))data=workflow?[workflow]:[];
  else if(url.pathname.endsWith('/support/tickets/summary'))data={backlog:1,unassigned:1,handoffs:0,openBreached:0,resolutionMet:8,resolutionMissed:2,responseMet:9,responseMissed:1};
  else if(url.pathname.endsWith('/support/tickets'))data=[{id:'00000000-0000-0000-0000-000000000004',key:'WT-1',title:'Preview support request',priority:'High',state:'open',category:'IT',assigneeId:null,teamId:null,responseDueAt:null,resolutionDueAt:null,version:1}];
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
 await capture('resume-current-desktop','/account/resumes','.resume-builder',1440,1000);
 await capture('resume-current-mobile','/account/resumes','.resume-builder',390,844);
 const fileInput=page.locator('.resume-upload input[type=file]').first();
 await fileInput.focus();
 checks.push({name:'resume-upload-keyboard-focus',focused:await fileInput.evaluate(el=>document.activeElement===el)});
 await capture('support-current-desktop','/preview-org/support','.support-center',1440,1000);
 await page.getByRole('button',{name:'Workflow studio',exact:true}).click();
 await page.locator('.react-flow').waitFor({state:'visible',timeout:15000});
 await page.locator('.react-flow__node').first().waitFor({state:'visible',timeout:15000});
 await page.waitForFunction(()=>document.querySelectorAll('.react-flow__edge').length===2);
 checks.push({name:'workflow-nodes-and-edges',nodes:await page.locator('.react-flow__node').count(),edges:await page.locator('.react-flow__edge').count()});
 await page.screenshot({path:artifact('workflow-current-desktop.png'),fullPage:true,animations:"disabled"});
 const save=page.getByRole('button',{name:'Save draft',exact:true});
 await save.click();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Save draft')?.disabled);
 assert.equal(saves.length,1);
 await page.locator('.react-flow__node[data-id=start]').click();
 assert.equal(await page.getByLabel('Label',{exact:true}).inputValue(),'Start');
 assert.equal(await save.isDisabled(),true,'Canvas selection must not edit the saved graph');
 const picker=page.locator('.workflow-node-picker').getByRole('button',{name:'Add staff note',exact:true});
 await picker.focus();await picker.press('Enter');
 assert.equal(await page.getByLabel('Label',{exact:true}).inputValue(),'Add staff note');
 assert.equal(await save.isDisabled(),true,'Keyboard selection must not edit the saved graph');
 const note=page.locator('.react-flow__node[data-id=note]');
 const before=await note.getAttribute('style');
 const box=await note.boundingBox();assert.ok(box);
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
 await page.mouse.down();await page.mouse.move(box.x+box.width/2+35,box.y+box.height/2+20,{steps:6});await page.mouse.up();
 assert.notEqual(await note.getAttribute('style'),before,'Dragging must move the node');
 assert.equal(await save.isEnabled(),true);
 await save.click();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Save draft')?.disabled);
 const previous=saves[0].graph.nodes.find(n=>n.id==='note'),moved=saves[1].graph.nodes.find(n=>n.id==='note');
 assert.ok(moved.x!==previous.x||moved.y!==previous.y,'Save must persist dragged coordinates');
 await page.getByRole('button',{name:'Add step',exact:true}).click();
 await page.locator('.react-flow__node').nth(3).waitFor({state:'visible'});
 await page.getByLabel('Label',{exact:true}).fill('Review current owner and team availability before escalation');
 await save.click();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Save draft')?.disabled);
 await page.setViewportSize({width:1080,height:900});
 await page.waitForFunction(()=>[...document.querySelectorAll('.react-flow__node')].length===4&&[...document.querySelectorAll('.react-flow__node')].every(n=>getComputedStyle(n).visibility==='visible'));
 assert.equal(await save.isDisabled(),true,'Canvas resize/measurements must not edit the saved graph');
 await page.reload();
 assert.equal(new URL(page.url()).searchParams.get('view'),'workflows','Workflow view must survive reload');
 await page.getByRole('button',{name:'Workflow studio',exact:true}).click();
 await page.locator('.workflow-library-row').filter({hasText:'Support triage'}).click();
 await page.getByRole('button',{name:'Discard',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.react-flow__node').length===4&&[...document.querySelectorAll('.react-flow__node')].every(n=>getComputedStyle(n).visibility==='visible'));
 assert.equal(await save.isDisabled(),true,'Loading saved nodes must keep the draft unchanged');
 const reloaded=await page.locator('.react-flow__node[data-id=note]').evaluate(n=>{const t=new DOMMatrixReadOnly(getComputedStyle(n).transform);return {x:t.e,y:t.f};});
 assert.ok(Math.abs(reloaded.x-moved.x)<0.01&&Math.abs(reloaded.y-moved.y)<0.01,'Reload must retain saved coordinates');
 checks.push({name:'workflow-selection-keyboard-drag-add-resize-save-and-reload',passed:true,saves:saves.length});
 workflow=null;
 await capture('support-current-mobile','/preview-org/support','.support-center',390,844);
 await page.getByRole('button',{name:'Workflow studio',exact:true}).click();
 await page.locator('.react-flow__node').first().waitFor({state:'visible',timeout:15000});
 await page.waitForFunction(()=>document.querySelectorAll('.react-flow__edge').length===2);
 await page.screenshot({path:artifact('workflow-current-mobile.png'),fullPage:true,animations:'disabled'});
 await page.locator('.workflow-canvas').scrollIntoViewIfNeeded();
 await page.screenshot({path:artifact('workflow-mobile-canvas.png'),animations:'disabled'});
 checks.push({name:'workflow-mobile',overflow:await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)});
 await capture('resume-final-desktop','/account/resumes','.resume-builder',1440,1000);
 const templateButtons=page.getByRole('group',{name:'Choose resume template'}).getByRole('button');
 assert.equal(await templateButtons.count(),templates.length);
 await templateButtons.nth(1).focus();await templateButtons.nth(1).press('Enter');
 assert.equal(await templateButtons.nth(1).getAttribute('aria-pressed'),'true');
 assert.equal(await page.getByLabel(/Template/).inputValue(),'2');
 checks.push({name:'resume-template-keyboard-selection',passed:true});
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.evaluate(()=>{localStorage.setItem('pm_theme','dark');document.documentElement.setAttribute('data-theme','dark');});
 assert.equal(await page.locator('.studio-hero-mark>span').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.screenshot({path:artifact('resume-final-dark-desktop.png'),fullPage:true,animations:'disabled'});
 await capture('support-final-dark-desktop','/preview-org/support','.support-center',1440,1000);
 await page.getByRole('button',{name:'Workflow studio',exact:true}).click();
 await page.locator('.workflow-canvas').waitFor({state:'visible'});
 await page.screenshot({path:artifact('workflow-final-dark-desktop.png'),fullPage:true,animations:'disabled'});
 checks.push({name:'dark-theme-and-reduced-motion',passed:true});
 const beforeInbox=inboxReads;
 await capture('inbox-empty-desktop','/account/integrations','.personal-inbox',1440,1000);
 assert.equal(inboxReads,beforeInbox,'Mailbox content must not be fetched until the user loads it');
 await page.getByRole('button',{name:'Load inbox',exact:true}).click();
 const inboxMessage=page.getByRole('group',{name:'Inbox messages'}).getByRole('button');
 await inboxMessage.waitFor({state:'visible'});await inboxMessage.focus();await inboxMessage.press('Enter');
 await page.locator('.inbox-body').waitFor({state:'visible'});
 assert.match(await page.locator('.inbox-body').textContent(),/<script>/,'Mail text must be rendered as literal text');
 assert.equal(await page.evaluate(()=>window.inboxUnsafe),undefined,'Mail text must never execute HTML');
 inboxBody='Please review the delivery milestones for the customer portal.\n\nThe integration review is scheduled for Friday, 16 October. Could you share the outstanding blockers before the review?\n\nThank you,\nThe project team';
 await inboxMessage.click();await page.waitForFunction(()=>document.querySelector('.inbox-body')?.textContent?.includes('customer portal'));
 assert.equal(attachmentReads,0,'Attachment metadata is loaded only by an explicit user action');assert.equal(attachmentDownloads,0);
 await page.getByRole('button',{name:'Show attachment list',exact:true}).click();
 await page.getByRole('button',{name:'Download review-notes.txt',exact:true}).waitFor({state:'visible'});assert.equal(attachmentReads,1);assert.equal(attachmentDownloads,0);
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download review-notes.txt',exact:true}).click();const file=await downloaded;
 assert.equal(file.suggestedFilename(),'review-notes.txt');assert.equal(await fs.readFile(await file.path(),'utf8'),'Synthetic private attachment content');assert.equal(attachmentDownloads,1);
 await page.locator('.inbox-attachments').screenshot({path:artifact('inbox-attachments-dark-desktop.png'),animations:'disabled'});
 checks.push({name:'inbox-attachments-explicit-metadata-loading-authenticated-binary-download-no-ai',passed:true});
 assert.equal(summaryCalls,0,'Inbox reading must never automatically call AI');
 await page.getByRole('button',{name:'Summarize conversation',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'visible'});assert.equal(summaryCalls,0,'Consent must precede generation');
 await page.getByRole('button',{name:'Summarize for 1 credit',exact:true}).click();
 await page.locator('.inbox-summary-points li').first().waitFor({state:'visible'});assert.equal(summaryCalls,1);
 assert.equal(await page.locator('.inbox-summary-points blockquote').count(),2);
 await page.getByRole('button',{name:'View cited message',exact:true}).first().click();
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'inbox-source-1001');
 await page.getByRole('button',{name:'Saved summaries',exact:true}).click();
 await page.locator('.inbox-summary-history button').click();assert.equal(summaryCalls,1,'Recovering a receipt must not generate again');
 await page.setViewportSize({width:1440,height:1600});
 await page.locator('.personal-inbox').screenshot({path:artifact('inbox-summary-dark-desktop.png'),animations:'disabled'});
 checks.push({name:'inbox-summary-explicit-credit-consent-exact-citations-keyboard-source-navigation-receipt-recovery',passed:true});
 await page.locator('.personal-inbox').screenshot({path:artifact('inbox-dark-desktop.png'),animations:'disabled'});
 await page.evaluate(()=>{localStorage.setItem('pm_theme','light');document.documentElement.setAttribute('data-theme','light');});
 await page.locator('.personal-inbox').screenshot({path:artifact('inbox-light-desktop.png'),animations:'disabled'});
 await page.locator('.personal-inbox').screenshot({path:artifact('inbox-summary-light-desktop.png'),animations:'disabled'});
 await page.locator('.inbox-attachments').screenshot({path:artifact('inbox-attachments-light-desktop.png'),animations:'disabled'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.getByLabel('Inbox provider').selectOption('microsoft');
 assert.equal(await page.locator('.inbox-body').count(),0,'Switching accounts must immediately clear prior mail content');
 assert.equal(await page.locator('.inbox-summary-points').count(),0,'Account changes must retire private summary text');
 assert.equal(await page.locator('.inbox-attachment-file').count(),0,'Account changes must retire attachment names and download tokens');
 await page.getByRole('button',{name:'Load inbox',exact:true}).click();
 await inboxMessage.waitFor({state:'visible'});await inboxMessage.click();await page.locator('.inbox-body').waitFor({state:'visible'});
 assert.equal(await page.getByRole('button',{name:'Project delivery review',exact:false}).getAttribute('aria-pressed'),'true');
 assert.match(await page.locator('.inbox-account').textContent(),/outlook/);
 await page.setViewportSize({width:390,height:844});
 // A breakpoint changes the account shell. Start with the mounted phone view, then select its account.
 await page.goto(origin+'/account/integrations');
 await page.getByLabel('Inbox provider').waitFor({state:'visible'});
 await page.getByLabel('Inbox provider').selectOption('microsoft');
 await page.locator('.inbox-account').filter({hasText:'outlook'}).waitFor({state:'visible'});
 await page.getByRole('button',{name:'Load inbox',exact:true}).click();
 await inboxMessage.waitFor({state:'visible'});await inboxMessage.click();await page.locator('.inbox-body').waitFor({state:'visible'});
 assert.match(await page.locator('.inbox-account').textContent(),/outlook/);
 await page.getByRole('button',{name:'Summarize conversation',exact:true}).click();
 await page.getByRole('button',{name:'Summarize for 1 credit',exact:true}).click();
 await page.locator('.inbox-summary-points li').first().waitFor({state:'visible'});
 // Retain the phone width, with enough capture height to keep the fixed account dock outside the card.
 await page.setViewportSize({width:390,height:1100});
 await page.locator('.inbox-summary').screenshot({path:artifact('inbox-summary-light-mobile.png'),animations:'disabled',style:'.m-tabs{visibility:hidden}'});
 await page.getByRole('button',{name:'Show attachment list',exact:true}).click();
 await page.locator('.inbox-attachment-file').waitFor({state:'visible'});
 // Component reference only: omit unrelated fixed navigation from the cutout; full-page checks retain it.
 await page.locator('.inbox-attachments').screenshot({path:artifact('inbox-attachments-light-mobile.png'),animations:'disabled',style:'.m-tabs{visibility:hidden}'});
 await page.locator('.personal-inbox').scrollIntoViewIfNeeded();
 await page.screenshot({path:artifact('inbox-light-mobile.png'),fullPage:true,animations:'disabled'});
 checks.push({name:'private-inbox-manual-load-keyboard-reading-literal-html-account-switch-mobile',passed:true,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
 inboxEnabled=false;
 const beforeDisabled=inboxReads;
 await page.reload();await page.locator('.inbox-status').waitFor({state:'visible'});
 assert.equal(await page.locator('.inbox-body').count(),0);assert.equal(inboxReads,beforeDisabled,'Disabled inbox cannot read provider content');
 checks.push({name:'private-inbox-disabled-gate-clears-content-without-provider-reads',passed:true});
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
 await page.setViewportSize({width:1440,height:1400});await page.goto(origin+'/account/integrations');await page.locator('.outlook-availability').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Load my Outlook calendars',exact:true}).click();await page.getByRole('checkbox',{name:'Focus time',exact:true}).waitFor({state:'visible'});await page.getByRole('checkbox',{name:'Focus time',exact:true}).check();
 await page.getByLabel('Outlook window start').fill('2026-10-14T10:00');await page.getByLabel('Outlook window end').fill('2026-10-14T12:00');await page.getByRole('button',{name:'Check selected calendars',exact:true}).click();await page.locator('.outlook-result').waitFor({state:'visible'});
 await page.locator('.outlook-availability').screenshot({path:artifact('outlook-availability-light-desktop.png'),animations:'disabled'});
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.setAttribute('data-theme','dark');});await page.locator('.outlook-availability').screenshot({path:artifact('outlook-availability-dark-desktop.png'),animations:'disabled'});
 calendarDenied=true;await page.getByRole('button',{name:'Check selected calendars',exact:true}).click();await page.locator('.outlook-error').waitFor({state:'visible'});
 assert.equal(await page.locator('.outlook-planning-grid').count(),0);assert.equal(await page.locator('.outlook-result').count(),0);
 checks.push({name:'outlook-revoked-access-clears-calendar-names-and-busy-results',passed:true});
 const beforeCalendarDisabled=calendarReads;calendarsEnabled=false;await page.reload();await page.locator('.outlook-status').waitFor({state:'visible'});
 assert.equal(await page.locator('.outlook-result').count(),0);assert.equal(await page.locator('.outlook-planning-grid').count(),0);assert.equal(calendarReads,beforeCalendarDisabled);
 checks.push({name:'outlook-calendar-disabled-gate-clears-private-state-without-reads',passed:true});
 // Regression checks for spacious writing, adaptive layout and same-browser native connection starts.
 for (const width of [320,390,820,1280,1440,1920]) {
  await capture(`resume-responsive-${width}`,'/account/resumes','.resume-builder',width,1000);
  const before=await page.locator('.resume-editor').evaluate(el=>el.getBoundingClientRect().width);
  await page.getByRole('group',{name:'Resume workspace view'}).getByRole('button',{name:'Edit',exact:true}).click();
  assert.equal(await page.locator('.resume-preview-panel').isVisible(),false);
  const after=await page.locator('.resume-editor').evaluate(el=>el.getBoundingClientRect().width);
  if(width>=1440)assert.ok(after>before+200,'Edit mode should give substantially more writing room');
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
  await page.getByLabel(/Template/).selectOption('2');
  assert.equal(await page.locator('.resume-paper.centered.ruled').count(),1);
  assert.match(await page.locator('.resume-paper').innerText(),/cross-functional teams/);
  if([390,1440].includes(width)) {
   await page.locator('.resume-paper').scrollIntoViewIfNeeded();await page.screenshot({path:artifact(`resume-preview-${width}.png`),animations:'disabled'});
  }
  checks.push({name:`resume-full-size-edit-preview-${width}`,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
 }
 await capture('connected-accounts-desktop','/account/integrations','.personal-account-grid',1440,1000);
 assert.equal(await page.locator('.connection-capabilities li').count(),6);
 await capture('connected-accounts-mobile','/account/integrations','.personal-account-grid',390,844);
 await page.close();page=await ctx.newPage();attachErrors();
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'userAgent',{value:'Mozilla/5.0 ProjectTrackerDesktop/1.0.0'});
  window.browserConnectionOpens=0;window.browserConnectionSlugs=[];
  window.ptDesktop={openConnectedAccounts:(slug)=>{window.browserConnectionOpens++;window.browserConnectionSlugs.push(slug);}};
 });
 await page.goto(origin+'/account/integrations');
 await page.getByRole('button',{name:'Reconnect',exact:true}).click();
 await page.getByRole('button',{name:'Reconnect Microsoft',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.browserConnectionOpens),2);
 assert.deepEqual(await page.evaluate(()=>window.browserConnectionSlugs),['preview-org','preview-org']);
 checks.push({name:'electron-starts-google-and-microsoft-in-system-browser',passed:true});
 const result={fixture:'Synthetic browser responses only; no live APIs, model calls, payments or external sends',checks,pageErrors:errors};
 await fs.writeFile(artifact('results.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
 assert.deepEqual(errors,[]);assert.ok(checks.every(c=>!c.overflow&&c.focused!==false));
} finally {await browser.close();}
