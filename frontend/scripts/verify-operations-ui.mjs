import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// The sidebar: hubs instead of duplicate places, sections that fold, drag to reorder (mouse and keyboard), Customize (pin, hide, reset),
// saved to the account; the Agents hub bar; pins on the phone's tab bar. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/operations-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const pid='00000000-0000-0000-0000-000000000003';
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const W=(n,title,status,priority,assignee,sla,type='Production Support')=>({id:`w${n}`,key:`WT-${n}`,number:n,title,description:null,workTypeId:'t1',workType:type,relatedProject:null,assignee:assignee?{id:assignee[0],name:assignee[1]}:null,reporter:{id:user.id,name:user.displayName},priority,status,startDate:null,dueDate:null,isOverdue:false,completedAt:status==='Completed'?iso(-600):null,createdAt:iso(-3000),version:1,commentCount:0,attachmentCount:0,can:{edit:true,delete:true},loggedMinutes:0,sla:sla?{response:null,resolution:{dueAt:iso(sla==='Breached'?-60:120),metAt:null,state:sla},state:sla}:null});
const tasks=[W(1,'Printer queue stuck on floor 3','ToDo','High',null,'Breached'),W(2,'VPN drops every hour','InProgress','Critical',['u2','Upendra Rao'],'AtRisk'),W(3,'Renew SSL certificate','OnHold','Medium',['u3','Jyothsna Reddy'],'Paused'),W(4,'Export monthly settlement report','ToDo','Low',['u2','Upendra Rao'],null,'Analysis'),W(5,'Reset MFA for new joiner','Completed','Medium',['u3','Jyothsna Reddy'],'Met')];
const members=[{userId:user.id,displayName:user.displayName,role:'Owner'},{userId:'u2',displayName:'Upendra Rao',role:'Member'},{userId:'u3',displayName:'Jyothsna Reddy',role:'Member'}];
let settings={canManage:true,businessHoursOnly:false,dayStartMinutes:540,dayEndMinutes:1080,workDays:[1,2,3,4,5],timeZone:'Asia/Kolkata',escalateOnBreach:false,escalateTo:null,rules:[{id:'r1',workTypeId:'t1',workType:'Production Support',mode:'round_robin',members:[{id:'u2',name:'Upendra Rao'},{id:'u3',name:'Jyothsna Reddy'}],escalateTo:null,enabled:true,lastAssigned:{id:'u2',name:'Upendra Rao'}}]};
const weeks=Array.from({length:13},(_,i)=>({weekStart:new Date(now-(12-i)*7*864e5).toISOString().slice(0,10),created:5+(i*7)%9,completed:4+(i*5)%8,breached:i%4===0?2:i%3===0?1:0,compliance:0.72+((i*13)%25)/100}));
const B=(name,open,completed,breached,compliance,h)=>({name,id:null,open,completed,breached,compliance,medianResolutionHours:h});
const insights={days:90,open:4,unassigned:1,breached:1,atRisk:1,compliance:0.86,medianResolutionHours:9.5,medianResponseMinutes:38,createdInPeriod:94,completedInPeriod:81,weeks,aging:[{label:'Under 2 days',count:2},{label:'2–7 days',count:1},{label:'1–4 weeks',count:1},{label:'Over 4 weeks',count:0}],
 byType:[B('Production Support',3,52,1,0.84,7.2),B('Analysis',1,18,0,0.94,30),B('Bug Fix',0,11,0,0.73,14)],byPriority:[B('Critical',1,6,0,1,2.1),B('High',1,22,1,0.8,6),B('Medium',1,40,0,0.88,12),B('Low',1,13,0,0.92,40)],byPerson:[B('Upendra Rao',2,40,1,0.83,8),B('Jyothsna Reddy',1,35,0,0.9,9),B('Unassigned',1,0,0,null,null)],businessHours:false,
 satisfaction:{asked:40,rated:31,average:4.3,satisfied:0.84,distribution:[2,1,2,9,17],weeks:weeks.map((w,i)=>({weekStart:w.weekStart,rated:i%3,average:i%3?3.8+(i%4)/5:null})),
  byPerson:[{name:'AI employee',id:null,rated:14,average:4.5},{name:'Upendra Rao',id:'u1',rated:11,average:4.1},{name:'Jyothsna Reddy',id:'u2',rated:6,average:3.9}],
  low:[{chatId:'w1',contact:'Ravi Kumar <b>bold</b>',rating:1,at:iso(-60*5),ticketKey:'WT-12',with:'Upendra'}],chats:120,aiOnly:78,handedOver:42,handoverReasons:[{label:'Customer asked for a person',count:25},{label:'Not in the documents',count:17}]}};
const writes=[],errors=[],checks=[];
let saved=null;
let voice={enabled:false,agentName:'Asha',companyName:'FiveStar',languages:['te','hi','en','ta'],knowledge:null,requireVerification:true,verificationRule:'date of birth and the last 4 digits of the loan number',transferNumber:null,workTypeId:null,storageKeyPattern:'{yyyy}/{MM}/{dd}/{callId}',archiveConfigured:false,canManage:true,availableLanguages:{en:'English',hi:'Hindi',te:'Telugu',ta:'Tamil',kn:'Kannada'}};let vcall=null;
let waChannels=[];const waChat={id:'w1',channelId:'ch1',channelName:'IT helpdesk',contact:'+91 98•••••210',contactName:'Ravi Kumar',language:'te',status:'open',mode:'ai',lastMessageAt:iso(0),lastText:'password reset కావాలి',unread:1,workTaskId:null,ticketKey:null,canReply:true,assigneeId:null,assigneeName:null,waitingSince:iso(-12),replyDueAt:iso(3),rating:null,verifiedUntil:iso(25)};
let waMessages=[{from:'contact',text:'నా లాగిన్ పని చేయడం లేదు, password reset కావాలి',at:iso(0)},{from:'ai',text:'సరేనండి, మీ employee ID చెప్పగలరా?',at:iso(0),by:'Asha',sources:[{documentId:'d7',key:'DOC-7',title:'Password reset guide'}]},
 {from:'contact',text:'[photo] the error',at:iso(0),media:{kind:'image',id:'5501',mime:'image/png',fileName:null,transcript:null}},
 {from:'contact',text:'[voice note] నా ID 4471',at:iso(0),media:{kind:'voice',id:'5502',mime:'audio/ogg',fileName:null,transcript:'నా ID 4471 <b>bold</b>'}},
 {from:'system',text:'Asha Rao took the chat.',at:iso(0)}];
const waSaved=[{title:'Reset steps',text:'Open the portal and press Forgot password.'}];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async()=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');if(!localStorage.getItem('pm_theme'))localStorage.setItem('pm_theme','light');});
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[];
   if(ep==='/api/v1/me/ui/operations'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});saved=b.value;data={key:'operations',value:saved,updatedAt:null};}
   else if(ep==='/api/v1/me/ui/operations')data={key:'operations',value:saved,updatedAt:null};
   else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
   else if(ep==='/api/v1/operations/bulk'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});for(const id of b.ids){const t=tasks.find(x=>x.id===id);if(b.priority)t.priority=b.priority;}data={updated:b.ids.length,failed:[]};}
   else if(/\/api\/v1\/work-tasks\/w\d+\/status/.test(ep)&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});const t=tasks.find(x=>ep.includes(`/${x.id}/`));t.status=b.status;data=t;}
   else if(ep==='/api/v1/operations/triage'&&method==='POST'){writes.push({ep});data={workTypeId:'t1',workType:'Production Support',typeReason:'3 similar work items were this type',priority:'High',priorityReason:'it mentions “urgent”',assignee:{id:'u2',name:'Upendra Rao'},assigneeReason:'resolved 4 similar items · 2 open now',duplicates:[{id:'w1',key:'WT-1',title:'Printer queue stuck on floor 3',status:'ToDo',assignee:null,score:71}],routed:'to the next person on the rota'};}
   else if(ep==='/api/v1/operations/settings'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});settings={...settings,...b};data=settings;}
   else if(ep==='/api/v1/agent/inbox')data={items:[],pending:0,canDecide:true};
   else if(ep==='/api/v1/support/channels'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});const ch={id:'ch1',name:b.name,teamId:null,teamName:null,phoneNumberId:b.phoneNumberId,businessAccountId:b.businessAccountId,displayPhone:null,verifiedName:null,enabled:true,autoReply:b.autoReply,agentName:b.agentName,workTypeId:null,webhookUrl:'https://projecttracker.in/api/v1/support/whatsapp/ch1',verifyToken:'0123456789abcdef0123456789abcdef',lastInboundAt:null,checkedAt:null,lastError:null,openChats:1,connectedAt:iso(0)};waChannels=[ch];data=ch;}
   else if(ep==='/api/v1/support/conversations/w1/media/5501'){await route.fulfill({contentType:'image/png',body:png});return;}
   else if(ep==='/api/v1/support/conversations/w1/media/5502'){await route.fulfill({contentType:'audio/ogg',body:Buffer.alloc(16)});return;}
   else if(ep==='/api/v1/support/conversations/w1/assign'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});waChat.assigneeId=b.userId;waChat.assigneeName=members.find(m=>m.userId===b.userId)?.displayName??null;waChat.mode='human';data={chat:waChat,messages:waMessages,savedReplies:waSaved};}
   else if(ep==='/api/v1/support/conversations/w1/suggest'&&method==='POST'){writes.push({ep});data={text:'మీ password reset link మీ mail కి పంపాము.'};}
   else if(ep==='/api/v1/support/conversations/w1/reply'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});waMessages=[...waMessages,{from:'agent',text:b.text,at:iso(0),by:'Asha Rao'}];waChat.mode='human';data={chat:waChat,messages:waMessages,savedReplies:waSaved};}
   else if(ep==='/api/v1/voice/settings'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});voice={...voice,...b};data=voice;}
   else if(ep==='/api/v1/voice/calls/test'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});vcall={id:'c1',channel:'test',direction:'inbound',callerNumber:null,language:'te',status:'active',startedAt:iso(0),endedAt:null,turns:[{role:'agent',text:'నమస్కారం, FiveStar కి స్వాగతం. నేను Asha.',at:iso(0)}],summary:null,workTaskId:null,ticketKey:null,verified:false,transferred:false,archiveKey:null};data={call:vcall,say:vcall.turns[0].text,ended:false};}
   else if(ep==='/api/v1/voice/calls/c1/say'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});vcall={...vcall,turns:[...vcall.turns,{role:'caller',text:b.text,at:iso(0)},{role:'tool',tool:'create_ticket',text:'Created ticket WT-9.',at:iso(0)},{role:'agent',text:'మీ అభ్యర్థన నమోదు చేయబడింది: WT-9.',at:iso(0)}],ticketKey:'WT-9',workTaskId:'w9'};data={call:vcall,say:'ok',ended:false};}
   else if(ep==='/api/v1/voice/calls/c1/end'&&method==='POST'){writes.push({ep});data={...vcall,status:'ended'};}
   else if(ep==='/api/v1/voice/connectors/test'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={ok:true,trace:[{step:'Source',status:'ok',detail:'loanNumber = ••••••7890, dob = 1990-04-12'},{step:'Request',status:'ok',detail:'Used the sample answer'},{step:'1. Date of birth matches',status:'passed',detail:'dob matches main.customer.dob'},{step:'2. Overdue accounts',status:'skipped',detail:'main.loan.status = ACTIVE is OVERDUE'},{step:'Response',status:'ok',detail:'balance = ₹1,24,999.50'}],raw:{main:b.draft.flow.samples.main},facts:{loan:'ending 7890',balance:'₹1,24,999.50',emiAmount:'₹4,850',emiDate:'5 November 2026'},say:'For your loan ending 7890, the outstanding balance is ₹1,24,999.50. Your next EMI of ₹4,850 is due on 5 November 2026.',action:'none',actionText:null,verifiedNow:true,agentSees:'{"ok":true}',error:null};}
   else if(ep==='/api/v1/voice/connectors'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={id:'k1',...b,hasSecret:!!b.secret,placeholders:['loanNumber'],updatedAt:iso(0)};}
   else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','tasks.view','tasks.edit','org.manage','reports.view','work.view','work.create','work.edit'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
    else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
    else if(ep==='/api/v1/work-tasks'){const st=url.searchParams.get('status'),open=url.searchParams.get('open');let it=tasks.filter(t=>(!st||t.status===st)&&(open!=='true'||['ToDo','InProgress','OnHold'].includes(t.status)));if(url.searchParams.get('unassigned')==='true')it=it.filter(t=>!t.assignee);if(url.searchParams.get('sla')==='breached')it=it.filter(t=>t.sla?.state==='Breached');data={items:it,page:1,pageSize:25,totalPages:1,totalItems:it.length};}
    else if(ep==='/api/v1/work-types')data=[{id:'t1',name:'Production Support',description:null,order:0,isActive:true,taskCount:3},{id:'t2',name:'Analysis',description:null,order:1,isActive:true,taskCount:1}];
    else if(ep==='/api/v1/workspace/members')data=members;
    else if(ep==='/api/v1/operations/settings')data=settings;
    else if(ep==='/api/v1/voice/settings')data=voice;
    else if(ep==='/api/v1/support/channels')data=waChannels;
    else if(ep==='/api/v1/support/conversations')data=[waChat];
    else if(ep==='/api/v1/support/conversations/w1')data={chat:waChat,messages:waMessages,savedReplies:waSaved};
    else if(ep==='/api/v1/support/queues')data={mine:0,unassigned:0,waiting:1,open:1,late:0};
    else if(ep==='/api/v1/teams')data=[];
    else if(ep==='/api/v1/voice/connectors')data=[];
    else if(ep==='/api/v1/voice/calls/c1')data={...vcall,status:'ended',endedAt:iso(0),summary:'Caller asked about EMI date; ticket WT-9 created.'};
    else if(ep==='/api/v1/voice/calls')data=vcall?[{id:'c1',channel:'test',callerNumber:null,language:'te',status:'ended',startedAt:iso(0),endedAt:iso(0),summary:'Caller asked about EMI date; ticket WT-9 created.',ticketKey:'WT-9',transferred:false}]:[];
    else if(ep==='/api/v1/operations/insights')data=insights;
    else if(ep==='/api/v1/work/sla')data={entitled:true,canManage:true,defaults:[{priority:'Critical',responseMinutes:30,resolutionMinutes:240},{priority:'High',responseMinutes:120,resolutionMinutes:1440},{priority:'Medium',responseMinutes:480,resolutionMinutes:4320},{priority:'Low',responseMinutes:1440,resolutionMinutes:10080}],overrides:[]};
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
  return ctx;};
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(500);await page.screenshot({path:path.join(out,name)});};
 let ctx=await make();let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/operations');await page.locator('.work-table').waitFor();
 const tabs=await page.locator('.ops-tabs .tab').allInnerTexts();assert.deepEqual(tabs.map(t=>t.trim()),['Tickets','Insights','Channels']);
 assert.equal(await page.locator('.ops-stat').count(),4,'the counts strip');assert.ok(await page.getByRole('button',{name:'Settings'}).isVisible(),'Settings is a header button');
 assert.equal(await page.locator('.ops-toolbar').count(),1,'one toolbar row');assert.equal(await page.locator('.work-table thead th',{hasText:'Related project'}).count(),0,'no column of dashes');
 // Views and saving one.
 await page.locator('.ops-stat',{hasText:'Unassigned'}).click();await page.waitForTimeout(400);
 assert.equal(await page.locator('.work-table tbody tr').count(),1);assert.ok(await page.locator('.ops-stat.on',{hasText:'Unassigned'}).isVisible());
 assert.ok(await page.locator('.ops-dd-btn[aria-label="View: Unassigned"]').isVisible(),'the view menu names the view');
 await page.locator('.ops-dd > summary').click();await page.getByRole('menuitemradio',{name:'Open',exact:true}).click();await page.waitForTimeout(300);
 await page.getByRole('button',{name:'Filters'}).click();await page.getByLabel('Service level',{exact:true}).click();await page.getByRole('option',{name:'With SLA targets',exact:true}).click();await page.getByRole('button',{name:'Filters'}).click();
 await page.locator('.ops-dd > summary').click();await page.waitForTimeout(200);await shot(page,'views-menu-1440.png');await page.getByRole('button',{name:'Save this view'}).click();await page.getByLabel('View name').fill('Desk open');await page.getByRole('button',{name:'Save',exact:true}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/me/ui/operations');i++)await page.waitForTimeout(100);
 assert.equal(saved.views[0].name,'Desk open');await page.locator('.ops-dd-btn[aria-label="View: Desk open"]').waitFor();
 await page.locator(".ops-dd > summary").click();await page.getByRole('menuitemradio',{name:'Open',exact:true}).click();await page.waitForTimeout(300);checks.push('views');
 // Bulk: pick two, raise priority.
 await page.getByLabel('Select WT-2').check();await page.getByLabel('Select WT-4').check();await page.locator('.ops-bulk').waitFor();
 await shot(page,'queue-bulk-1440.png');
 await page.getByLabel('Set priority').click();await page.getByRole('option',{name:'High',exact:true}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/operations/bulk');i++)await page.waitForTimeout(100);
 assert.deepEqual(writes.find(w=>w.ep==='/api/v1/operations/bulk').b,{ids:['w2','w4'],priority:'High'});checks.push('bulk');
 // Board: drag WT-4 from To Do to In Progress.
 await page.getByRole('button',{name:'Board'}).click();await page.locator('.ops-board').waitFor();await page.waitForTimeout(300);
 assert.equal(await page.locator('.ops-col').count(),4);
 const card=page.locator('.ops-card',{hasText:'Export monthly settlement report'});const target=page.locator('.ops-col.InProgress');
 const a=await card.boundingBox(),b=await target.boundingBox();
 await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(a.x+a.width/2+20,a.y+a.height/2,{steps:3});
 await page.mouse.move(b.x+b.width/2,b.y+120,{steps:15});await shot(page,'board-drag-1440.png');await page.mouse.up();
 for(let i=0;i<20&&!writes.some(w=>w.ep.endsWith('/w4/status'));i++)await page.waitForTimeout(100);
 assert.equal(writes.find(w=>w.ep.endsWith('/w4/status')).b.status,'InProgress');
 await page.waitForTimeout(500);await shot(page,'board-1440.png');checks.push('board-drag');
 // Insights.
 await page.locator('.ops-tabs .tab',{hasText:'Insights'}).click();await page.locator('.ops-kpis').waitFor();await page.waitForTimeout(700);
 assert.ok((await page.locator('.ops-kpis').innerText()).includes('86%'));assert.equal(await page.locator('.ops-aging > div').count(),4);
 const csat=page.getByRole('region',{name:'Customer satisfaction'});await csat.scrollIntoViewIfNeeded();
 assert.ok((await csat.innerText()).includes('4.3 / 5'));assert.ok((await csat.innerText()).includes('65%'));assert.equal(await csat.getByRole('list',{name:'Ratings by score'}).getByRole('listitem').count(),5);
 assert.ok(await csat.getByText('Ravi Kumar <b>bold</b>').isVisible());assert.equal(await csat.getByRole('link',{name:'Open chat'}).getAttribute('href'),'/preview-org/operations?view=whatsapp&chat=w1');
 checks.push('csat');
 await shot(page,'insights-1440.png');checks.push('insights');
 // Settings: business hours on.
 await page.getByRole('button',{name:'Settings'}).click();await page.locator('.ops-settings').waitFor();
 await page.getByText('Count business hours only').click();await page.getByRole('button',{name:'Save',exact:true}).first().click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/operations/settings');i++)await page.waitForTimeout(100);
 assert.equal(writes.find(w=>w.ep==='/api/v1/operations/settings').b.businessHoursOnly,true);
 assert.ok(await page.locator('.ops-rule',{hasText:'Production Support'}).isVisible());await shot(page,'settings-1440.png');checks.push('settings');
 // New work: smart triage.
 await page.locator('.ops-tabs .tab',{hasText:'Tickets'}).click();await page.getByRole('button',{name:'List'}).click();await page.getByRole('button',{name:'New ticket'}).click();
 await page.getByPlaceholder('e.g. Fix production issue in payment calculation').fill('Printer stuck urgent on floor 3');
 await page.locator('.ops-triage').waitFor({timeout:5000});assert.ok(await page.locator('.ops-dupe',{hasText:'WT-1'}).isVisible());
 await page.locator('.ops-sug',{hasText:'High priority'}).click();await shot(page,'triage-1440.png');checks.push('triage');
 // Voice agent: settings, then a typed test call in Telugu that creates a ticket.
 await page.goto(origin+'/preview-org/operations?view=voice');await page.locator('.va-top').waitFor();
 await page.locator('.va-kpi').first().waitFor();await shot(page,'voice-overview-1440.png');
 await page.getByRole('tab',{name:'Agent'}).click();await page.locator('.va-langs').waitFor();
 // Selected language chips stay readable in both themes (text vs. the background actually behind it, WCAG contrast).
 const contrast=(sel)=>page.evaluate((sel)=>{
  const parse=(c)=>{const m=c.match(/[\d.]+/g).map(Number);return {r:m[0],g:m[1],b:m[2],a:m[3]??1};};
  const el=document.querySelector(sel);let fg=parse(getComputedStyle(el).color);
  const layers=[];for(let n=el;n;n=n.parentElement){const b=parse(getComputedStyle(n).backgroundColor);if(b.a>0)layers.push(b);if(b.a>=1)break;}
  let bg={r:255,g:255,b:255};for(const l of layers.reverse())bg={r:l.r*l.a+bg.r*(1-l.a),g:l.g*l.a+bg.g*(1-l.a),b:l.b*l.a+bg.b*(1-l.a)};
  const lum=(c)=>{const f=(v)=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;};return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b);};
  const [a,b]=[lum(fg),lum(bg)].sort((x,y)=>y-x);return (a+.05)/(b+.05);},sel);
 for(const theme of ['light','dark']){
  await page.evaluate((t)=>{localStorage.setItem('pm_theme',t);},theme);await page.reload();await page.locator('.va-langs button.on').first().waitFor();
  const c=await contrast('.va-langs button.on');assert.ok(c>=4.5,`selected language chip contrast ${c.toFixed(2)} in ${theme} theme`);
  await shot(page,`voice-settings-${theme}-1440.png`);
 }
 await page.evaluate(()=>localStorage.setItem('pm_theme','light'));await page.reload();await page.locator('.va-langs').waitFor();checks.push('theme-contrast');
 await page.locator('.va-langs button',{hasText:'Kannada'}).click();
 await page.locator('.va-savebar.show').getByRole('button',{name:'Save',exact:true}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/voice/settings');i++)await page.waitForTimeout(100);
 assert.deepEqual(writes.find(w=>w.ep==='/api/v1/voice/settings').b.languages,['te','hi','en','ta','kn']);
 // Tools: start from the loan template, walk the four parts of the flow, test it offline with the sample, then save it with its flow.
 await page.getByRole('tab',{name:'Tools'}).click();await page.locator('.vt-empty').waitFor();
 await page.getByRole('button',{name:'New tool'}).click();await page.locator('.vt-template',{hasText:'Loan details'}).click();
 await page.locator('.vb-rail').waitFor();await shot(page,'voice-tool-source-1440.png');
 for(const part of ['Request','Logic','Response']){await page.locator('.vb-node',{hasText:part}).click();await page.locator('.vb-editor-head h3',{hasText:part}).waitFor();await shot(page,`voice-tool-${part.toLowerCase()}-1440.png`);}
 await page.locator('.vb-node',{hasText:'Logic'}).click();await page.locator('.vb-step.verify').waitFor();
 await page.getByRole('button',{name:'Use the examples'}).click();await page.getByRole('button',{name:'Run test'}).click();
 await page.locator('.vb-say').waitFor();await page.locator('.vb-facts',{hasText:'₹1,24,999.50'}).waitFor();await shot(page,'voice-tool-test-1440.png');
 const tested=writes.find(w=>w.ep==='/api/v1/voice/connectors/test').b;
 assert.equal(tested.useSamples,true);assert.equal(tested.inputs.loanNumber,'1234567890');assert.equal(tested.draft.flow.steps[0].type,'verify');
 await page.getByRole('button',{name:'Save tool'}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/voice/connectors');i++)await page.waitForTimeout(100);
 const savedTool=writes.find(w=>w.ep==='/api/v1/voice/connectors').b;
 assert.equal(savedTool.name,'loan_details');assert.equal(savedTool.flow.requiresVerifiedCaller,true);assert.ok(savedTool.flow.fields.some(f=>f.format==='inr'));checks.push('voice-tools');
 // A narrow screen: the flow rail scrolls sideways instead of squeezing the editor.
 await page.setViewportSize({width:390,height:844});await page.getByRole('tab',{name:'Tools'}).click();await page.getByRole('button',{name:'New tool'}).click();
 await page.locator('.vt-template',{hasText:'Payment status'}).click();await page.locator('.vb-rail').waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'the tool builder scrolls sideways on a phone');assert.deepEqual(await cutOff(page),[],'cut off at the right edge');
 await shot(page,'voice-tool-390.png');await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/operations?view=voice');await page.locator('.va-top').waitFor();
 await page.getByRole('button',{name:'Test call'}).click();await page.getByRole('dialog').getByRole('button',{name:'Start'}).click();
 await page.locator('.va-bubble.agent').first().waitFor();
 await page.getByLabel('What the caller says').fill('నా EMI ఎప్పుడు?');await page.getByLabel('What the caller says').press('Enter');
 await page.locator('.va-tool',{hasText:'create_ticket'}).waitFor();await shot(page,'voice-test-1440.png');
 await page.getByRole('button',{name:'Hang up'}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/voice/calls/c1/end');i++)await page.waitForTimeout(100);checks.push('voice');
 await page.getByRole('tab',{name:'Calls'}).click();await page.locator('.va-calldetail .va-transcript').waitFor();await shot(page,'voice-calls-1440.png');
 // Switching tabs never moves the screen: scroll down a little, go from a tall tab to a short one and back, and the tab bar stays put.
 await page.setViewportSize({width:1440,height:700});await page.getByRole('tab',{name:'Agent'}).click();await page.locator('.va-langs').waitFor();
 await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(150);
 const barTop=()=>page.evaluate(()=>Math.round(document.querySelector('.va-tabs').getBoundingClientRect().top));
 const t0=await barTop();
 for(const name of ['Calls','Setup','Agent','Overview','Tools']){await page.getByRole('tab',{name}).click();await page.waitForTimeout(250);const t=await barTop();assert.ok(Math.abs(t-t0)<=1,`tab bar moved ${t-t0}px switching to ${name}`);}
 await page.setViewportSize({width:1440,height:1000});checks.push('tabs-stay-put');
 // WhatsApp: a team connects its number, sees the webhook setup, then answers a chat from the inbox.
 await page.goto(origin+'/preview-org/operations?view=whatsapp');await page.locator('.wa-hero').waitFor();
 await page.getByRole('button',{name:'Connect WhatsApp'}).click();
 const dlg=page.getByRole('dialog');await dlg.getByLabel('Name',{exact:true}).fill('IT helpdesk');await dlg.getByLabel('Phone number ID').fill('123456789012345');
 await dlg.getByLabel('WhatsApp Business Account ID').fill('998877665544332');await dlg.getByLabel('Permanent access token').fill('EAAG'+'x'.repeat(40));await dlg.getByLabel('App secret').fill('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
 // Template texts to submit in WhatsApp Manager, and verified actions behind a one-time code.
 await dlg.getByText('Templates to submit in WhatsApp Manager').click();assert.equal(await dlg.locator('.wa-drafts li').count(),4);
 assert.ok(await dlg.getByRole('button',{name:'Copy verify_code (en)'}).isVisible());
 await dlg.getByText('Answer account questions after a one-time code').click();await dlg.getByLabel('Registered mobile is at').waitFor();
 await dlg.getByText('Answer account questions after a one-time code').click();checks.push('verified-actions-form');
 await dlg.getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByRole('dialog').getByText('/api/v1/support/whatsapp/ch1').waitFor();await shot(page,'whatsapp-setup-1440.png');
 assert.equal(writes.find(w=>w.ep==='/api/v1/support/channels').b.phoneNumberId,'123456789012345');
 await page.getByRole('button',{name:'Done'}).click();await page.locator('.wa-number',{hasText:'IT helpdesk'}).waitFor();
 // Once connected, numbers sit behind one button; the desk is the page.
 await page.getByRole('button',{name:'Numbers'}).click();await page.getByRole('dialog').locator('.wa-channel',{hasText:'IT helpdesk'}).waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'Done'}).click();
 assert.match(await page.locator('.wa-chats button',{hasText:'Ravi Kumar'}).innerText(),/reply in [1-3]m/);
 await page.locator('.wa-chats button',{hasText:'Ravi Kumar'}).click();await page.locator('.wad-pane .wa-msg.ai').waitFor();
 assert.ok(await page.locator('.wad-pane .wa-verified').isVisible());
 // The photo opens in the chat; the voice note shows what was said, as text.
 await page.locator('.wa-media-img img').waitFor();
 assert.match(await page.locator('.wa-media-voice').innerText(),/నా ID 4471 <b>bold<\/b>/);
 assert.equal(await page.locator('.wa-media-voice b').count(),0);
 assert.match(await page.locator('.wa-note').innerText(),/took the chat/);
 // Owner, saved replies under "/", a suggested reply, then send.
 await page.getByLabel('Owner').click();await page.getByRole('option',{name:'Upendra Rao'}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/support/conversations/w1/assign');i++)await page.waitForTimeout(100);
 assert.equal(writes.find(w=>w.ep==='/api/v1/support/conversations/w1/assign').b.userId,'u2');
 await page.getByLabel('Reply').fill('/res');await page.locator('.wa-saved button',{hasText:'Reset steps'}).waitFor();
 await page.getByLabel('Reply').press('Enter');assert.equal(await page.getByLabel('Reply').inputValue(),'Open the portal and press Forgot password.');
 await page.getByRole('button',{name:'Suggest'}).click();
 for(let i=0;i<20&&(await page.getByLabel('Reply').inputValue()).startsWith('Open');i++)await page.waitForTimeout(100);
 assert.match(await page.getByLabel('Reply').inputValue(),/password reset link/);
 await page.getByLabel('Reply').fill('Reset link sent to your mail.');await page.getByLabel('Reply').press('Enter');
 await page.locator('.wa-msg.agent',{hasText:'Reset link'}).waitFor();await shot(page,'whatsapp-chat-1440.png');checks.push('whatsapp');
 assert.equal(await page.locator('.wa-sources').getByRole('link',{name:'DOC-7 Password reset guide'}).getAttribute('href'),'/preview-org/documents/d7');checks.push('answer-sources');
 await page.close();await ctx.close();
 // Phone.
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/operations?view=board');await page.locator('.ops-board').waitFor();await page.waitForTimeout(400);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(await cutOff(page),[],'cut off at the right edge');await shot(page,'board-390.png');
 await page.goto(origin+'/preview-org/operations?view=insights');await page.locator('.ops-kpis').waitFor();await page.waitForTimeout(500);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(await cutOff(page),[],'cut off at the right edge');await shot(page,'insights-390.png');checks.push('phone');
 // The desk on a phone: the list, then one chat full screen with a way back.
 await page.goto(origin+'/preview-org/operations?view=whatsapp');await page.locator('.wa-chats button',{hasText:'Ravi Kumar'}).waitFor();await page.waitForTimeout(300);
 await fitsPhone(page,'whatsapp list',assert);
 await page.locator('.wa-chats button',{hasText:'Ravi Kumar'}).click();await page.locator('.wad-pane .wa-msg.ai').waitFor();await page.waitForTimeout(300);
 await fitsPhone(page,'whatsapp chat',assert);
 // The chat covers the screen, reply box included, above the app's tab bar.
 const box=await page.getByLabel('Reply').boundingBox();assert.ok(box&&box.y+box.height<=844,'reply box on screen');
 assert.equal(await page.evaluate(()=>{const r=document.querySelector('.wad-full').getBoundingClientRect();return r.top===0&&r.height>=840;}),true);
 const hit=await page.evaluate(()=>{const e=document.elementFromPoint(195,830);return !!e?.closest('.wad-full');});assert.equal(hit,true,'nothing of the app covers the chat');
 await shot(page,'whatsapp-chat-390.png');
 await page.getByRole('button',{name:'Back to the chats'}).click();await page.locator('.wad-full').waitFor({state:'detached'});checks.push('whatsapp-phone');
 await page.close();await ctx.close();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
