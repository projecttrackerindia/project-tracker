import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';

const origin='https://projecttracker-preview.test';const dist=path.resolve('dist');
const artifacts=path.resolve(process.env.PM_UI_ARTIFACTS||'test-results/enterprise-ui','conversations');await fs.mkdir(artifacts,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Alex Morgan',email:'preview@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const colleague={userId:'00000000-0000-0000-0000-000000000003',name:'Sam Rivera',role:'Member',online:true,lastReadAt:'2026-10-12T10:00:00Z'};
const workspace={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Design Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:2};
const conversation={id:'00000000-0000-0000-0000-000000000010',type:'Direct',name:'Sam Rivera',members:[{...colleague}, {userId:user.id,name:user.displayName,role:'Admin',online:true,lastReadAt:'2026-10-12T10:00:00Z'}],unread:0,isMuted:false,canManage:false,otherUserId:colleague.userId,projectId:null,unreadMentions:0,lastMessage:null,lastActivityAt:'2026-10-12T10:00:00Z'};
const errors=[];const checks=[];let writes=0;
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try {
 const context=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  // The classic Assistant page is what this checks; the AI-first Home (the default) is checked in verify-command-ui.
  await context.addInitScript(()=>{try{if(!localStorage.getItem('pm_home_mode'))localStorage.setItem('pm_home_mode','classic');}catch{}});
 await context.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());const endpoint=url.pathname;
  if(url.origin!==origin || endpoint.startsWith('/hubs/')){await route.abort();return;}
  if(endpoint.endsWith('/avatar')){await route.fulfill({status:404,contentType:'application/json',body:'{"message":"No synthetic profile photo"}'});return;}
  if(!endpoint.startsWith('/api/')){
   const file=path.resolve(dist,endpoint.startsWith('/assets/')?endpoint.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));
   const type={'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream';
   await route.fulfill({status:200,contentType:type,body:await fs.readFile(file),headers:path.extname(file)==='.html'?{'content-security-policy':csp}:{}});return;
  }
  let data=[];
  if(endpoint.endsWith('/auth/refresh'))data={accessToken:`x.${Buffer.from(JSON.stringify({wid:workspace.id,exp:4102444800})).toString('base64url')}.x`,expiresAt:'2099-01-01T00:00:00Z',user};
  else if(endpoint==='/api/v1/me')data={user,workspaces:[workspace],fingerprint:'preview',pendingConsent:[],current:{...workspace,permissions:['org.manage','work.view','reports.view','chat.view'],modules:{projects:3,work:3,ai:3,chat:3,people:3,documents:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
  else if(endpoint.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
  else if(endpoint.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true,model:'synthetic',provider:'Gemini'};
  else if(endpoint.endsWith('/ai/usage'))data={month:'2026-10',creditsUsed:223,creditsLimit:1000,creditsLeft:777,unlimited:false,maxTier:'deep',attachments:true,actions:true,tiers:['quick','standard','deep'].map((id,i)=>({id,label:id,model:'synthetic',credits:i+1,allowed:true,description:'Preview mode'})),attachmentTypes:[],maxFiles:3,maxImageMb:2,maxDocumentMb:2,requestLimits:{perMinute:20,perHour:300,perDay:1500}};
  else if(endpoint.endsWith('/ai/starters'))data={greeting:'Welcome back',starters:[]};
  else if(endpoint==='/api/v1/ai/conversations/c1')data={id:'c1',title:'Delivery check',messages:[
    {id:'m1',role:'user',content:'How is delivery going?',reasoning:null,tier:null,model:null,routeReason:null,credits:0,status:'complete',tools:[],actions:[],attachments:[],createdAt:new Date(Date.now()-3600e3).toISOString()},
    {id:'m2',role:'assistant',content:'Delivery is on track: two tasks are waiting on vendor keys.',reasoning:null,tier:'standard',model:'synthetic',routeReason:'Needs project data',credits:2,status:'complete',tools:[],actions:[],attachments:[],createdAt:new Date(Date.now()-3590e3).toISOString()}]};
  else if(endpoint==='/api/v1/agent/command-center')data={greeting:'Good morning',headline:'Nothing urgent.',since:new Date().toISOString(),counts:{attention:0,toDecide:0,dueToday:0,overdue:0,blocking:0,checkIns:0,meetingsToday:0,atRisk:0},
    attention:[],today:[],changes:[],health:[],reliability:{kept:0,missed:0,open:0,moved:0},checkIns:[],owe:[],delegations:[]};
  else if(endpoint==='/api/v1/chat/conversations')data=[conversation];
  else if(endpoint.endsWith('/messages'))data={items:[{id:'00000000-0000-0000-0000-000000000011',conversationId:conversation.id,senderId:colleague.userId,senderName:colleague.name,kind:'User',replyTo:null,editedAt:null,body:'The project review is ready. We can discuss the next milestone here.',createdAt:'2026-10-12T10:05:00Z',attachments:[],reactions:[],isDeleted:false}],hasMore:false};
  else if(endpoint.includes('/unread')||endpoint.includes('/counts'))data={count:0,total:0};
  else if(endpoint==='/api/v1/timer')data=null;
  else if(endpoint.endsWith('/workspace/logo'))data={hasLogo:false};
  if(route.request().method()!=='GET'&&!endpoint.endsWith('/auth/refresh')){
   assert.ok(endpoint.endsWith('/read')||endpoint.endsWith('/presence'),'No model calls or customer writes allowed: '+endpoint);writes++;
  }
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});
 });
 // v2: an assistant conversation (/?c=…) opens the full assistant page on Home, whose ask box is .ai-composer.
 for(const [width,height] of [[320,740],[390,844],[768,1024],[740,390]]){
  for(const [kind,url,composer] of [['agent','/preview-org/?c=c1','.ai-composer'],['chat','/preview-org/chat/'+conversation.id,'.composer']]){
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width,height});
   await page.goto(origin+url);await page.locator(composer).waitFor({state:'visible'});await page.evaluate(()=>document.fonts.ready);
   await page.waitForFunction(s=>!!document.querySelector(s)&&!!document.querySelector('.m-tabs'),composer);await page.waitForTimeout(150);
   const geometry=await page.evaluate(selector=>{
    const i0=document.querySelector(selector),t0=document.querySelector(".m-tabs");if(!i0||!t0)return {missing:[!!i0,!!t0,location.pathname,document.body.innerText.slice(0,200)]};const input=i0.getBoundingClientRect();const tabs=t0.getBoundingClientRect();
    return {inputBottom:input.bottom,tabsTop:tabs.top,tabsBottom:tabs.bottom,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1};
   },composer);
   assert.ok(geometry.tabsBottom===0?geometry.inputBottom<=geometry.height+1:geometry.inputBottom<=geometry.tabsTop+1,JSON.stringify(geometry));   // the tab bar hides inside a conversation; then the composer sits on the screen's bottomassert.ok(geometry.tabsBottom<=height+1);assert.equal(geometry.overflow,false);
   await page.screenshot({path:path.join(artifacts,`${kind}-${width}.png`),animations:'disabled'});checks.push(`${kind}-${width}-composer-above-navigation`);
   if(width===390){
    await page.locator(composer+' :is(textarea,[contenteditable="true"])').focus();
    await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:410});visualViewport.dispatchEvent(new Event('resize'));});
    await page.waitForFunction(()=>document.querySelector('.m-shell').classList.contains('keyboard-open'));
    assert.equal(await page.locator('.m-tabs').isVisible(),false);
    await page.screenshot({path:path.join(artifacts,`${kind}-keyboard.png`),animations:'disabled'});checks.push(`${kind}-keyboard-keeps-composer-visible`);
    const box=await page.locator(composer).boundingBox();const layout=await page.evaluate(()=>Object.fromEntries(['.m-shell','.m-main','.content','.ai-shell','.ai-main','.ai-scroll'].map(selector=>{const e=document.querySelector(selector);return [selector,e?{height:e.getBoundingClientRect().height,minHeight:getComputedStyle(e).minHeight,style:e.getAttribute('style')}:null];})));assert.ok(box.y+box.height<=411,JSON.stringify({kind,box,layout}));
    await page.locator(composer+' :is(textarea,[contenteditable="true"])').blur();await page.evaluate(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});
    await page.locator('.m-tabs').waitFor({state:'visible'});checks.push(`${kind}-navigation-restored-after-keyboard`);
   }
   if(kind==='agent'&&width===390){await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.agent-ribbon').first().evaluate(e=>getComputedStyle(e).animationName),'none');checks.push('agent-mark-reduced-motion');}
   await page.close();
  }
 }
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify({fixture:'Synthetic APIs only; keyboard geometry simulated; no actual model or customer messages',checks,pageErrors:errors,syntheticReadReceipts:writes},null,2));console.log(JSON.stringify({checks,pageErrors:errors,artifacts}));
} finally {await browser.close();}
