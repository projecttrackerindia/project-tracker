import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// The sidebar: hubs instead of duplicate places, sections that fold, drag to reorder (mouse and keyboard), Customize (pin, hide, reset),
// saved to the account; the Agents hub bar; pins on the phone's tab bar. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/operations-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
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
 byType:[B('Production Support',3,52,1,0.84,7.2),B('Analysis',1,18,0,0.94,30),B('Bug Fix',0,11,0,0.73,14)],byPriority:[B('Critical',1,6,0,1,2.1),B('High',1,22,1,0.8,6),B('Medium',1,40,0,0.88,12),B('Low',1,13,0,0.92,40)],byPerson:[B('Upendra Rao',2,40,1,0.83,8),B('Jyothsna Reddy',1,35,0,0.9,9),B('Unassigned',1,0,0,null,null)],businessHours:false};
const writes=[],errors=[],checks=[];
let saved=null;
let voice={enabled:false,agentName:'Asha',companyName:'FiveStar',languages:['te','hi','en','ta'],knowledge:null,requireVerification:true,verificationRule:'date of birth and the last 4 digits of the loan number',transferNumber:null,workTypeId:null,storageKeyPattern:'{yyyy}/{MM}/{dd}/{callId}',archiveConfigured:false,canManage:true,availableLanguages:{en:'English',hi:'Hindi',te:'Telugu',ta:'Tamil',kn:'Kannada'}};let vcall=null;
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
   if(ep==='/api/v1/me/ui/operations'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});saved=b.value;data={key:'operations',value:saved,updatedAt:null};}
   else if(ep==='/api/v1/me/ui/operations')data={key:'operations',value:saved,updatedAt:null};
   else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
   else if(ep==='/api/v1/operations/bulk'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});for(const id of b.ids){const t=tasks.find(x=>x.id===id);if(b.priority)t.priority=b.priority;}data={updated:b.ids.length,failed:[]};}
   else if(/\/api\/v1\/work-tasks\/w\d+\/status/.test(ep)&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});const t=tasks.find(x=>ep.includes(`/${x.id}/`));t.status=b.status;data=t;}
   else if(ep==='/api/v1/operations/triage'&&method==='POST'){writes.push({ep});data={workTypeId:'t1',workType:'Production Support',typeReason:'3 similar work items were this type',priority:'High',priorityReason:'it mentions “urgent”',assignee:{id:'u2',name:'Upendra Rao'},assigneeReason:'resolved 4 similar items · 2 open now',duplicates:[{id:'w1',key:'WT-1',title:'Printer queue stuck on floor 3',status:'ToDo',assignee:null,score:71}],routed:'to the next person on the rota'};}
   else if(ep==='/api/v1/operations/settings'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});settings={...settings,...b};data=settings;}
   else if(ep==='/api/v1/agent/inbox')data={items:[],pending:0,canDecide:true};
   else if(ep==='/api/v1/voice/settings'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});voice={...voice,...b};data=voice;}
   else if(ep==='/api/v1/voice/calls/test'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});vcall={id:'c1',channel:'test',direction:'inbound',callerNumber:null,language:'te',status:'active',startedAt:iso(0),endedAt:null,turns:[{role:'agent',text:'నమస్కారం, FiveStar కి స్వాగతం. నేను Asha.',at:iso(0)}],summary:null,workTaskId:null,ticketKey:null,verified:false,transferred:false,archiveKey:null};data={call:vcall,say:vcall.turns[0].text,ended:false};}
   else if(ep==='/api/v1/voice/calls/c1/say'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});vcall={...vcall,turns:[...vcall.turns,{role:'caller',text:b.text,at:iso(0)},{role:'tool',tool:'create_ticket',text:'Created ticket WT-9.',at:iso(0)},{role:'agent',text:'మీ అభ్యర్థన నమోదు చేయబడింది: WT-9.',at:iso(0)}],ticketKey:'WT-9',workTaskId:'w9'};data={call:vcall,say:'ok',ended:false};}
   else if(ep==='/api/v1/voice/calls/c1/end'&&method==='POST'){writes.push({ep});data={...vcall,status:'ended'};}
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
    else if(ep==='/api/v1/voice/connectors')data=[];
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
 const tabs=await page.locator('.ops-tabs .tab').allInnerTexts();assert.deepEqual(tabs.map(t=>t.trim()),['Queue','Board','Insights','Voice agent','Settings']);
 // Views and saving one.
 await page.locator('.ops-view',{hasText:'Unassigned'}).click();await page.waitForTimeout(400);
 assert.equal(await page.locator('.work-table tbody tr').count(),1);assert.ok(await page.locator('.ops-view.on',{hasText:'Unassigned'}).isVisible());
 await page.locator('.ops-view',{hasText:'Open'}).first().click();await page.waitForTimeout(300);
 await page.getByRole('button',{name:'Save view'}).click();await page.getByLabel('View name').fill('Desk open');await page.getByRole('button',{name:'Save',exact:true}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/me/ui/operations');i++)await page.waitForTimeout(100);
 assert.equal(saved.views[0].name,'Desk open');await page.locator('.ops-view.saved').waitFor();checks.push('views');
 // Bulk: pick two, raise priority.
 await page.getByLabel('Select WT-2').check();await page.getByLabel('Select WT-4').check();await page.locator('.ops-bulk').waitFor();
 await shot(page,'queue-bulk-1440.png');
 await page.getByLabel('Set priority').click();await page.getByRole('option',{name:'High',exact:true}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/operations/bulk');i++)await page.waitForTimeout(100);
 assert.deepEqual(writes.find(w=>w.ep==='/api/v1/operations/bulk').b,{ids:['w2','w4'],priority:'High'});checks.push('bulk');
 // Board: drag WT-4 from To Do to In Progress.
 await page.locator('.ops-tabs .tab',{hasText:'Board'}).click();await page.locator('.ops-board').waitFor();await page.waitForTimeout(300);
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
 await shot(page,'insights-1440.png');checks.push('insights');
 // Settings: business hours on.
 await page.locator('.ops-tabs .tab',{hasText:'Settings'}).click();await page.locator('.ops-settings').waitFor();
 await page.getByText('Count business hours only').click();await page.getByRole('button',{name:'Save',exact:true}).first().click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/operations/settings');i++)await page.waitForTimeout(100);
 assert.equal(writes.find(w=>w.ep==='/api/v1/operations/settings').b.businessHoursOnly,true);
 assert.ok(await page.locator('.ops-rule',{hasText:'Production Support'}).isVisible());await shot(page,'settings-1440.png');checks.push('settings');
 // New work: smart triage.
 await page.locator('.ops-tabs .tab',{hasText:'Queue'}).click();await page.getByRole('button',{name:'New work task'}).click();
 await page.getByPlaceholder('e.g. Fix production issue in payment calculation').fill('Printer stuck urgent on floor 3');
 await page.locator('.ops-triage').waitFor({timeout:5000});assert.ok(await page.locator('.ops-dupe',{hasText:'WT-1'}).isVisible());
 await page.locator('.ops-sug',{hasText:'High priority'}).click();await shot(page,'triage-1440.png');checks.push('triage');
 // Voice agent: settings, then a typed test call in Telugu that creates a ticket.
 await page.goto(origin+'/preview-org/operations?view=voice');await page.locator('.va-hero').waitFor();
 await page.locator('.va-langs button',{hasText:'Kannada'}).click();
 await page.getByRole('button',{name:'Save',exact:true}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/voice/settings');i++)await page.waitForTimeout(100);
 assert.deepEqual(writes.find(w=>w.ep==='/api/v1/voice/settings').b.languages,['te','hi','en','ta','kn']);
 await page.getByRole('button',{name:'Try a test call'}).click();await page.getByRole('dialog').getByRole('button',{name:'Start'}).click();
 await page.locator('.va-bubble.agent').first().waitFor();
 await page.getByLabel('What the caller says').fill('నా EMI ఎప్పుడు?');await page.getByLabel('What the caller says').press('Enter');
 await page.locator('.va-tool',{hasText:'create_ticket'}).waitFor();await shot(page,'voice-test-1440.png');
 await page.getByRole('button',{name:'Hang up'}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/voice/calls/c1/end');i++)await page.waitForTimeout(100);checks.push('voice');
 await page.close();await ctx.close();
 // Phone.
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/operations?view=board');await page.locator('.ops-board').waitFor();await page.waitForTimeout(400);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await shot(page,'board-390.png');
 await page.goto(origin+'/preview-org/operations?view=insights');await page.locator('.ops-kpis').waitFor();await page.waitForTimeout(500);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await shot(page,'insights-390.png');checks.push('phone');
 await page.close();await ctx.close();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
