import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

const origin='https://projecttracker-preview.test';const dist=path.resolve('dist');
const artifacts=path.resolve('test-results/chat-ui');await fs.mkdir(artifacts,{recursive:true});
const csp = await appCsp();
const at=(m)=>new Date(Date.now()-m*60000).toISOString();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Alex Morgan',email:'preview@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const colleague={userId:'00000000-0000-0000-0000-000000000003',name:'Sam Rivera',role:'Member',online:true,lastReadAt:'2026-10-12T10:00:00Z'};
const workspace={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Design Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:2};
const conversation={id:'00000000-0000-0000-0000-000000000010',type:'Direct',name:'Sam Rivera',members:[{...colleague}, {userId:user.id,name:user.displayName,role:'Admin',online:true,lastReadAt:'2026-10-12T10:00:00Z'}],unread:0,isMuted:false,canManage:false,otherUserId:colleague.userId,projectId:null,unreadMentions:0,lastMessage:null,lastActivityAt:'2026-10-12T10:00:00Z'};
const M=(id,mine,body,mins,extra={})=>({id:'00000000-0000-0000-0000-0000000001'+String(id).padStart(2,'0'),conversationId:conversation.id,senderId:mine?user.id:colleague.userId,senderName:mine?user.displayName:colleague.name,kind:'User',replyTo:null,editedAt:null,body,createdAt:at(mins),attachments:[],reactions:[],isDeleted:false,...extra});
const items=[M(1,false,'I will start the RAML today',1500),M(2,false,'Hi Alex',9),M(3,false,'Can you review the **payments** spec when you get a minute?',8,{reactions:[{emoji:'👍',count:1,mine:true,names:['Alex Morgan']}]}),M(4,true,'Hey Sam',5),M(5,true,'Sure, looking now. Will share comments by lunch.',4,{editedAt:at(3)})];
const errors=[];const checks=[];let writes=0;let started=null;
// A question waiting for Alex (desktop part): it leaves "Waiting for your answer" as soon as Alex replies, without a reload.
let questionOn=false,answered=false;const question=M(6,false,'Can we ship the payments fix today?',1,{asksMe:true});
// Our own video calls: one is on in another chat (the bar at the top offers to join), and this chat can start its own.
const liveCall={id:'c-live',title:'Payments sync',kind:'chat',projectId:null,projectKey:null,conversationId:'00000000-0000-0000-0000-000000000011',status:'live',startedAt:at(6),endedAt:null,startedBy:colleague.userId,startedByName:colleague.name,agentEnabled:false,agentStatus:null,canEnd:false,people:[{userId:colleague.userId,name:colleague.name,role:'host',inCall:true,joinedAt:at(6)}]};
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try {
 const make=async(opts={})=>{const context=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block',...opts});
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
  else if(endpoint==='/api/v1/chat/conversations')data=[conversation];
  else if(endpoint==='/api/v1/chat/questions')data=questionOn&&!answered?[{messageId:question.id,conversationId:conversation.id,conversationName:'Sam Rivera',senderName:'Sam Rivera',snippet:question.body,at:question.createdAt,threadRootId:null}]:[];
  else if(endpoint.endsWith('/messages')&&route.request().method()==='POST'){const b=route.request().postDataJSON();answered=true;data=M(7,true,b.body??'',0);}
  else if(endpoint.endsWith('/messages'))data={items:questionOn?[...items,{...question,asksMe:!answered}]:items,hasMore:false};
  else if(endpoint.includes('/unread')||endpoint.includes('/counts'))data={count:0,total:0};
  else if(endpoint==='/api/v1/timer')data=null;
  else if(endpoint.endsWith('/workspace/logo'))data={hasLogo:false};
  else if(endpoint==='/api/v1/calls/status')data={available:true,maxParticipants:50};
  else if(endpoint==='/api/v1/calls/live')data=[liveCall];
  else if(endpoint==='/api/v1/calls'&&route.request().method()==='POST'){started=route.request().postDataJSON();data={...liveCall,id:'c-new',title:'Chat call',conversationId:conversation.id,startedBy:user.id,startedByName:user.displayName,canEnd:true,people:[{userId:user.id,name:user.displayName,role:'host',inCall:false,joinedAt:null},{userId:colleague.userId,name:colleague.name,role:'member',inCall:false,joinedAt:null}]};}
  else if(endpoint==='/api/v1/calls/c-new')data={...liveCall,id:'c-new',title:'Chat call',conversationId:conversation.id,startedBy:user.id,startedByName:user.displayName,canEnd:true,people:[{userId:user.id,name:user.displayName,role:'host',inCall:false,joinedAt:null}]};
  if(route.request().method()!=='GET'&&!endpoint.endsWith('/auth/refresh')){
   writes++;
  }
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});
 });
 return context;};
 const touch=async(page,sel,steps)=>page.evaluate(async([sel,steps])=>{const el=document.querySelector(sel);const r=el.getBoundingClientRect();const mk=(x,y)=>new Touch({identifier:1,target:el,clientX:x,clientY:y});
  const x0=r.left+20,y0=r.top+r.height/2;el.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[mk(x0,y0)],changedTouches:[mk(x0,y0)]}));
  for(const [dx,wait] of steps){await new Promise(r=>setTimeout(r,wait));if(dx)el.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,touches:[mk(x0+dx,y0)],changedTouches:[mk(x0+dx,y0)]}));}
  el.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[],changedTouches:[mk(x0,y0)]}));},[sel,steps]);
 // Phone: no action rows under messages; long press opens the sheet; swipe replies; the send button wakes up with text.
 let context=await make({hasTouch:true,isMobile:true});let page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/chat/'+conversation.id);await page.locator('.composer').waitFor();await page.waitForTimeout(400);
 assert.equal(await page.locator('.msg-actions').evaluateAll(els=>els.filter(e=>e.getBoundingClientRect().height>0).length),0);
 assert.equal(await page.locator('.composer-tools').count(),0);assert.equal(await page.locator('.composer-hint').count(),0);
 assert.equal(await page.locator('.msg:not(.mine) .avatar').count(),2,'one avatar per run of messages');
 assert.ok((await page.locator('.bubble-meta').count())>=5);
 const head=await page.locator('.chat-head').evaluate(h=>{const t=h.querySelector('.chat-head-text');const n=h.querySelector('h2');return {text:t&&Math.round(t.getBoundingClientRect().width),name:n&&Math.round(n.getBoundingClientRect().width),shown:n&&getComputedStyle(n).display,full:n&&n.scrollWidth};});
 assert.ok(head.name>=60,`the other person's name is readable in a phone's chat header: ${JSON.stringify(head)}`);
 await page.screenshot({path:path.join(artifacts,'phone-thread.png')});checks.push('phone-clean-thread');
 await touch(page,'[data-msg$="103"] .bubble-wrap',[[0,520]]);await page.locator('.msg-sheet').waitFor();
 await page.waitForTimeout(300);await page.screenshot({path:path.join(artifacts,'phone-sheet.png')});
 assert.ok(await page.getByRole('button',{name:'Copy text'}).isVisible());
 await page.locator('.msg-sheet-list').getByRole('button',{name:'Reply',exact:true}).click();await page.locator('.composer-ctx').waitFor();
 await page.locator('.composer-ctx button').click();checks.push('long-press-sheet');
 await touch(page,'[data-msg$="102"] .bubble-wrap',[[20,30],[60,30],[100,30],[120,30]]);await page.locator('.composer-ctx').waitFor();checks.push('swipe-to-reply');
 assert.equal(await page.locator('.send-btn.ready:not(.mic)').count(),0);
 await page.locator('.composer-editable').click();await page.keyboard.type('Thanks!');
 assert.equal(await page.locator('.send-btn.ready:not(.mic)').count(),1);
 await page.screenshot({path:path.join(artifacts,'phone-typing.png')});checks.push('send-wakes');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(await cutOff(page),[],'cut off at the right edge');
 await page.close();await context.close();
 // Desktop: hover toolbar still there; ＋ › Formatting opens formatting (Talk's composer keeps Aa under ＋).
 context=await make();page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1280,height:860});
 await page.goto(origin+'/preview-org/chat/'+conversation.id);await page.locator('.composer').waitFor();
 await page.locator('[data-msg$="103"] .bubble').hover();assert.ok(await page.locator('[data-msg$="103"] .msg-actions').isVisible());
 await page.getByRole('button',{name:'More: poll, send later'}).click();await page.getByRole('menuitem',{name:'Formatting'}).click();assert.ok(await page.locator('.composer-tools').isVisible());
 await page.screenshot({path:path.join(artifacts,'desktop.png')});checks.push('desktop-hover-and-format');
 // A question to Alex waits in the list and on the message; replying clears both at once, with no reload.
 questionOn=true;await page.goto(origin+'/preview-org/chat/'+conversation.id);await page.locator('.composer').waitFor();
 await page.locator('.q-box').waitFor();assert.match(await page.locator('.q-box').innerText(),/Waiting for your answer[\s\S]*ship the payments fix today/);
 assert.equal(await page.locator('[data-msg$="106"] .asks-flag').count(),1);
 await page.locator('.composer-editable').click();await page.keyboard.type('Yes, shipping at 4.');await page.keyboard.press('Enter');
 await page.locator('.q-box').waitFor({state:'detached',timeout:5000});
 assert.equal(await page.locator('[data-msg$="106"] .asks-flag').count(),0,'the question on the message is no longer marked');
 checks.push('reply-clears-waiting-question');
 // A call on elsewhere shows as a bar with Join; starting one here notifies everyone in the chat and opens the camera check.
 assert.match(await page.locator('[data-testid="call-live-bar"]').innerText(),/Sam Rivera.*is in “Payments sync”/s);
 assert.equal(await page.locator('[data-testid="call-live-bar"] a').getAttribute('href'),'/preview-org/calls/c-live');
 await page.locator('[data-testid="call-live-bar"]').getByRole('button',{name:'Not now'}).click();assert.equal(await page.locator('[data-testid="call-live-bar"]').count(),0);
 await page.locator('.chat-head [data-testid="start-call"]').click();const dlg=page.getByRole('dialog');await dlg.waitFor();
 assert.match(await dlg.innerText(),/Everyone in this chat gets a notification to join/);
 assert.equal(await dlg.locator('.call-agent').count(),0,'the project agent is offered only in projects');
 await page.waitForTimeout(400);await page.screenshot({path:path.join(artifacts,'start-call.png')});
 await dlg.locator('[data-testid="start-call-go"]').click();await page.waitForURL(/\/calls\/c-new$/);
 assert.deepEqual(started,{projectId:null,conversationId:conversation.id,invite:[],agent:false});   // the server notifies everyone in the chat
 await page.locator('[data-testid="call-prejoin"]').waitFor();checks.push('start-call-from-chat');
 await page.close();await context.close();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,writes,errors}));
}finally{await browser.close();}
