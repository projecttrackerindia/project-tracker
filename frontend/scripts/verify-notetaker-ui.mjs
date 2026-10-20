import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Notetaker: readiness, join a call for me, automatic settings, sessions, minutes (write, create tasks, email). Synthetic API only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/notetaker-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const pid='00000000-0000-0000-0000-000000000003';
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const W=(n,title,status,priority,assignee,sla,type='Production Support')=>({id:`w${n}`,key:`WT-${n}`,number:n,title,description:null,workTypeId:'t1',workType:type,relatedProject:null,assignee:assignee?{id:assignee[0],name:assignee[1]}:null,reporter:{id:user.id,name:user.displayName},priority,status,startDate:null,dueDate:null,isOverdue:false,completedAt:status==='Completed'?iso(-600):null,createdAt:iso(-3000),version:1,commentCount:0,attachmentCount:0,can:{edit:true,delete:true},loggedMinutes:0,sla:sla?{response:null,resolution:{dueAt:iso(sla==='Breached'?-60:120),metAt:null,state:sla},state:sla}:null});
const imap=[],presets=[],gmail=[],rediff=[];const assist=null;const writes=[],errors=[],checks=[];
const overview={settings:{projectId:'p1',autoJoin:false,autoMinutes:true,autoEmail:true,autoTasks:false,deleteTranscript:true},projects:[{id:'p1',key:'ATL',name:'Atlas',agentReady:true},{id:'p2',key:'ORB',name:'Orbit',agentReady:false}],botReady:true,signedInAccount:true,accountName:'Atlas Notetaker',calendarConnected:true,aiAvailable:true};
const sessions=[{id:'s1',projectId:'p1',projectName:'Atlas',title:'Daily stand-up',meetUrl:'https://meet.google.com/aaa-bbbb-ccc',start:iso(-5),end:iso(25),status:'in_call',workerStatus:'in_call_recording',error:null,transcriptLength:1200,hasMinutes:false,minutesStatus:null,mine:true,automatic:true},
 {id:'s2',projectId:'p1',projectName:'Atlas',title:'Client review',meetUrl:'https://meet.google.com/ddd-eeee-fff',start:iso(-240),end:iso(-180),status:'done',workerStatus:'done',error:null,transcriptLength:9000,hasMinutes:false,minutesStatus:null,mine:true,automatic:false},
 {id:'s3',projectId:'p1',projectName:'Atlas',title:'Vendor call',meetUrl:null,start:iso(-2000),end:iso(-1940),status:'failed',workerStatus:'fatal',error:'Nobody let the bot into the meeting.',transcriptLength:0,hasMinutes:false,minutesStatus:null,mine:true,automatic:false}];
const MIN={sessionId:'s2',projectId:'p1',title:'Client review · 20 Oct 2026',status:'ready',createdAt:iso(0),sentAt:null,model:'test',content:{title:'Client review · 20 Oct 2026',summary:'The client approved the dashboard design and asked for the export by Friday.',attendees:['Ravi','Asha'],discussion:['Dashboard design walkthrough'],decisions:['Design approved'],actionItems:[{task:'Build CSV export',owner:'Asha',due:'2026-10-23'},{task:'Share UAT plan',owner:null,due:null}],risks:['Data access pending'],nextMeeting:'Monday 10 am'}};
let minutes=null;
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async()=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');});
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[];
   const p=url.searchParams;
   if(ep==='/api/v1/me/notetaker/join'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});sessions.unshift({id:'s9',projectId:'p1',projectName:'Atlas',title:b.title||'Meet call',meetUrl:b.url,start:iso(0),end:iso(60),status:'scheduled',workerStatus:'joining',error:null,transcriptLength:0,hasMinutes:false,minutesStatus:null,mine:true,automatic:false});data=sessions[0];}
   else if(ep==='/api/v1/me/notetaker/settings'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});overview.settings=b;data=b;}
   else if(ep==='/api/v1/me/notetaker/sessions/s2/minutes'&&method==='POST'){writes.push({ep});minutes=MIN;sessions[1].hasMinutes=true;sessions[1].minutesStatus='ready';data=MIN;}
   else if(ep==='/api/v1/me/notetaker/sessions/s2/minutes/send'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={...MIN,status:'sent',sentAt:iso(0)};}
   else if(ep==='/api/v1/projects/p1/tasks'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data={id:'t9'};}
   else if(ep==='/api/v1/me/mailbox/send'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={accepted:true,to:'ravi@client.test',cc:b.replyAll?'meena@client.test':'',subject:'Re: Portal login fix'};}
   else if(ep==='/api/v1/me/mailbox/agent/assist'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data=assist;}
   else if(ep==='/api/v1/me/mailbox/agent/compose'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={body:b.draft.trim()+'\n\nImproved.',model:'test'};}
   else if(ep==='/api/v1/me/mailbox/accounts/imap'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});const a={id:'00000000-0000-0000-0000-0000000000bb',provider:b.provider,name:'Rediffmail Pro',email:b.email,connectedAt:iso(0),lastSyncedAt:iso(0),lastError:null};imap=[...imap,a];data=a;}
   else if(/\/api\/v1\/work-tasks\/w\d+\/status/.test(ep)&&method==='PUT'){writes.push({ep,b:req.postDataJSON()});data={id:'w2'};}
   else if(/\/api\/v1\/work-tasks\/w\d+\/comments/.test(ep)&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data={id:'c1'};}
   else if(ep==='/api/v1/work-tasks'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data={id:'w9'};}
   else if(ep==='/api/v1/agent/inbox')data={items:[],pending:0,canDecide:true};
   else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
   else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','tasks.view','tasks.edit','org.manage','reports.view','work.view','work.create','work.edit'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
    else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
    else if(ep==='/api/v1/integrations/google/status')data={connected:true,googleEmail:'asha@example.test',connectedAt:iso(-9000),lastError:null,calendarAccess:true,mailEnabled:true,mailSendAccess:true,inboxEnabled:true,inboxAccess:true};
    else if(ep==='/api/v1/integrations/microsoft/status')data={enabled:true,configured:true,connected:false,email:null,mailSendAccess:false,inboxEnabled:true,inboxAccess:false,calendarsEnabled:true,calendarAccess:false};
    else if(ep==='/api/v1/me/mailbox/accounts')data={imap,presets};
    else if(ep==='/api/v1/me/notetaker')data={...overview,sessions};
    else if(ep==='/api/v1/me/notetaker/sessions/s2/minutes')data=minutes;
    else if(ep==='/api/v1/me/mailbox/agent/options')data={available:true,credits:1};
    else if(ep==='/api/v1/me/mailbox/messages'){const acc=p.get('account');const list=p.get('folder')==='sent'?[]:acc==='google'?gmail:acc.startsWith('imap:')?rediff:[];data={account:acc,email:acc==='google'?'asha@example.test':'asha@rediffmail.com',folder:p.get('folder'),messages:list.map(({body,...m})=>m),cursor:null};}
    else if(ep==='/api/v1/me/mailbox/thread'){const acc=p.get('account');const m=[...gmail,...rediff].find(x=>x.id===p.get('messageId'));data={account:acc,email:'asha@example.test',folder:'inbox',threadId:m.id,messages:[m],truncated:false};}
    else if(ep==='/api/v1/work-tasks'){const st=url.searchParams.get('status'),open=url.searchParams.get('open');let it=tasks.filter(t=>(!st||t.status===st)&&(open!=='true'||['ToDo','InProgress','OnHold'].includes(t.status)));if(url.searchParams.get('unassigned')==='true')it=it.filter(t=>!t.assignee);if(url.searchParams.get('sla')==='breached')it=it.filter(t=>t.sla?.state==='Breached');data={items:it,page:1,pageSize:25,totalPages:1,totalItems:it.length};}
    else if(ep==='/api/v1/work-types')data=[{id:'t1',name:'Production Support',description:null,order:0,isActive:true,taskCount:3},{id:'t2',name:'Analysis',description:null,order:1,isActive:true,taskCount:1}];
    else if(ep==='/api/v1/workspace/members')data=members;
    else if(ep==='/api/v1/operations/settings')data=settings;
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
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);await page.screenshot({path:path.join(out,name),fullPage:true});};
 const waitWrite=async(test)=>{for(let i=0;i<30&&!writes.some(test);i++)await new Promise(r=>setTimeout(r,100));return writes.find(test);};
 let ctx=await make();let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/notetaker');await page.locator('.nt-hero').waitFor();
 assert.ok(await page.locator('nav a[href$="/notetaker"]').first().isVisible());
 assert.match(await page.locator('.nt-checks').innerText(),/Atlas Notetaker/);
 assert.match(await page.locator('.nt-session').first().innerText(),/In the call/);
 assert.match(await page.locator('.nt-session',{hasText:'Vendor call'}).innerText(),/Nobody let the bot/);checks.push('overview');
 await page.getByPlaceholder('https://meet.google.com/abc-defg-hij').fill('https://meet.google.com/xyz-abcd-efg');
 await page.getByPlaceholder('Client sync').fill('Sprint planning');
 await page.getByPlaceholder(/Ask when the UAT/).fill('Ask about the release date');
 await page.getByRole('button',{name:'Join now'}).click();
 const j=await waitWrite(w=>w.ep==='/api/v1/me/notetaker/join');assert.equal(j.b.url,'https://meet.google.com/xyz-abcd-efg');assert.equal(j.b.projectId,'p1');assert.equal(j.b.minutes,60);assert.equal(j.b.instructions,'Ask about the release date');
 checks.push('join');
 await page.getByRole('radio',{name:/Fully automatic/}).click();
 const at=await waitWrite(w=>w.ep==='/api/v1/me/notetaker/settings');assert.equal(at.b.autoJoin,true);assert.equal(at.b.autoTasks,true);assert.equal(at.b.deleteTranscript,true);
 await page.waitForFunction(()=>document.querySelector('[role=radio][aria-checked=true]')?.textContent.includes('Fully automatic'));checks.push('settings','automation');
 await shot(page,'notetaker-1440.png');
 await page.locator('.nt-session',{hasText:'Client review'}).getByRole('button',{name:/Write minutes/}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Write the minutes'}).click();
 await page.locator('.nt-minutes').waitFor();assert.match(await page.locator('.nt-minutes').innerText(),/Design approved/);
 await page.locator('.nt-actions li',{hasText:'Build CSV export'}).getByRole('button',{name:'Create task'}).click();
 const t=await waitWrite(w=>w.ep==='/api/v1/projects/p1/tasks');assert.equal(t.b.title,'Build CSV export');assert.equal(t.b.dueDate,'2026-10-23');
 await shot(page,'minutes-1440.png');checks.push('minutes-tasks');
 await page.getByRole('button',{name:'Email minutes'}).click();
 const mail=page.getByRole('dialog',{name:'Email the minutes'});await mail.waitFor();
 await mail.getByPlaceholder('attendees@company.com, …').fill('ravi@client.test');
 assert.match(await mail.locator('textarea').inputValue(),/1\. Build CSV export — Asha \(by 2026-10-23\)/);
 await mail.getByRole('button',{name:'Send',exact:true}).click();
 await page.getByRole('dialog',{name:'Email the minutes?'}).getByRole('button',{name:'Send',exact:true}).click();
 const s=await waitWrite(w=>w.ep.endsWith('/minutes/send'));assert.equal(s.b.account,'google');assert.equal(s.b.to,'ravi@client.test');assert.equal(s.b.confirmed,true);checks.push('email');
 await page.close();await ctx.close();
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/notetaker');await page.locator('.nt-hero').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await shot(page,'notetaker-390.png');checks.push('phone');
 await page.close();await ctx.close();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
