import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';

// Webhooks release 2: outgoing filters, health, the full history with "send again", a replay window, the event explorer, and incoming
// addresses with the mapping set by example. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/webhooks-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false,mfaEnabled:true};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const pay='00000000-0000-0000-0000-0000000000a1', web='00000000-0000-0000-0000-0000000000a2';
const projects=[{id:pay,key:'PAY',name:'Payments'},{id:web,key:'WEB',name:'Website'}];
let hook={id:'h1',name:'Billing system',url:'https://billing.example.test/hooks',events:['task.*'],isActive:true,disabledReason:null,createdAt:iso(-60*24*10),lastDeliveryAt:iso(-3),lastStatus:'failed',
 consecutiveFailures:3,format:'Json',filterProjects:[],filterPriorities:[],filterStatuses:[],health:{total:120,succeeded:114,failed:6,successRate:95,averageMs:184},disableAfter:10};
const catalogue=[
 {event:'task.created',group:'task',groupLabel:'Project tasks',sample:{summary:'Created PAY-12 “Fix refund rounding”',entity:{type:'Task',id:'0'},projectId:'0',actor:{id:'0',name:'Asha Rao'},oldValue:null,newValue:null}},
 {event:'task.status_changed',group:'task',groupLabel:'Project tasks',sample:{summary:'PAY-12: status In Progress → Done',entity:{type:'Task',id:'0'},oldValue:'In Progress',newValue:'Done'}},
 {event:'issue.reported',group:'issue',groupLabel:'Issues',sample:{summary:'Reported issue PAY-I3 “Wrong EMI on statement” in UAT',entity:{type:'Issue',id:'0'}}},
 {event:'whatsapp.rated',group:'whatsapp',groupLabel:'WhatsApp chats',sample:{conversationId:'0',channel:'Support',contactName:'Kavya',rating:5}},
];
const deliveries=Array.from({length:30},(_,i)=>({id:`d${i}`,eventType:i%5===0?'task.status_changed':'task.created',status:i<2?'Failed':'Succeeded',attempts:i<2?6:1,responseStatus:i<2?500:200,error:i<2?'The receiver answered 500.':null,
 createdAt:iso(-i*7),deliveredAt:i<2?null:iso(-i*7),nextAttemptAt:null,durationMs:120+i,replayOf:null}));
const health={days:7,total:120,succeeded:114,failed:6,pending:0,successRate:95,averageMs:184,p95Ms:420,series:Array.from({length:7},(_,i)=>({day:new Date(now-(6-i)*86400000).toISOString().slice(0,10),total:10+i*3,failed:i===5?6:0,averageMs:150+i})),
 lastError:'The receiver answered 500.',lastFailureAt:iso(-3),consecutiveFailures:3,warnAfter:5,disableAfter:10,warned:false};
let incoming=[];
const sample='{"status":"firing","alerts":[{"fingerprint":"ab12","labels":{"alertname":"CoreBankingEOD","instance":"cbs-01","severity":"critical"}}]}';
const fields=[{path:'status',placeholder:'{{status}}',value:'firing'},{path:'alerts.0.fingerprint',placeholder:'{{alerts.0.fingerprint}}',value:'ab12'},
 {path:'alerts.0.labels.alertname',placeholder:'{{alerts.0.labels.alertname}}',value:'CoreBankingEOD'},{path:'alerts.0.labels.instance',placeholder:'{{alerts.0.labels.instance}}',value:'cbs-01'},
 {path:'alerts.0.labels.severity',placeholder:'{{alerts.0.labels.severity}}',value:'critical'}];
const render=(t)=>(t??'').replace(/\{\{\s*([^}]+?)\s*\}\}/g,(_,p)=>fields.find(f=>f.path===p)?.value??'');
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');});
 await ctx.grantPermissions(['clipboard-read','clipboard-write'],{origin});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  const body=()=>{try{return req.postDataJSON();}catch{return null;}};
  if(ep==='/api/v1/webhooks/h1'&&method==='PUT'){const b=body();writes.push({ep,method,b});hook={...hook,...b};data=hook;}
  else if(ep==='/api/v1/webhooks/h1/test'&&method==='POST'){writes.push({ep,method,b:body()});data={id:'t1',eventType:body()?.event??'ping',status:'Pending',attempts:0};}
  else if(ep==='/api/v1/webhooks/h1/deliveries/d0/replay'&&method==='POST'){writes.push({ep,method});data={...deliveries[0],id:'r1',status:'Pending',replayOf:'d0'};}
  else if(ep==='/api/v1/webhooks/h1/replay'&&method==='POST'){writes.push({ep,method,b:body()});data={queued:2};}
  else if(ep==='/api/v1/incoming-webhooks'&&method==='POST'){const b=body();writes.push({ep,method,b});
   const h={id:'i1',name:b.name,url:'https://api.projecttracker-preview.test/api/v1/hooks/in/0123456789abcdef0123456789abcdef01234567',target:b.target,projectId:b.projectId,projectName:projects.find(p=>p.id===b.projectId)?.name??null,
    workTypeId:null,workTypeName:null,assigneeId:null,assigneeName:null,defaultPriority:b.defaultPriority,mapping:{title:'{{title}}'},mergeMinutes:b.mergeMinutes,isActive:true,requiresSecret:!!b.requireSecret,
    actingUserId:user.id,actingName:user.displayName,received:0,createdCount:0,mergedCount:0,lastReceivedAt:null,lastError:null,hasSample:false,createdAt:iso(0)};
   incoming=[h];data={hook:h,secret:b.requireSecret?'whsec_synthetic_secret_value':null};}
  else if(ep==='/api/v1/incoming-webhooks/i1'&&method==='PUT'){const b=body();writes.push({ep,method,b});incoming=[{...incoming[0],...b,hasSample:true,received:3,createdCount:1,mergedCount:2}];data={hook:incoming[0],secret:null};}
  else if(ep==='/api/v1/incoming-webhooks/suggest'&&method==='POST'){writes.push({ep,method,b:body()});data={title:'{{alerts.0.labels.alertname}} on {{alerts.0.labels.instance}}',priority:'{{alerts.0.labels.severity}}',dedupeKey:'{{alerts.0.fingerprint}}',resolveWhen:'{{status}}',resolveValues:'resolved,ok'};}
  else if(ep==='/api/v1/incoming-webhooks/preview'&&method==='POST'){const b=body();const m=b.mapping??{};
   data={title:render(m.title)||'(address name)',description:render(m.description)||null,priority:'Critical',dedupeKey:render(m.dedupeKey)||render(m.title),assignee:null,resolves:false,problems:[],fields};}
  else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
  else{
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','tasks.view','org.manage','reports.view','work.view','work.create'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{API_ACCESS:1,AI_ASSISTANT:3,AUDIT_LOG:1}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/webhooks')data=[hook];
   else if(ep==='/api/v1/webhooks/events')data=catalogue.map(c=>c.event).concat(['audit.logged']);
   else if(ep==='/api/v1/webhooks/catalogue')data=catalogue;
   else if(ep==='/api/v1/webhooks/h1/health')data=health;
   else if(ep==='/api/v1/webhooks/h1/history'){const p=Number(url.searchParams.get('page')||1),st=url.searchParams.get('status');const rows=deliveries.filter(d=>!st||d.status===st);data={items:rows.slice((p-1)*25,p*25),total:rows.length,page:p,pageSize:25};}
   else if(ep==='/api/v1/webhooks/h1/deliveries/d0')data={delivery:deliveries[0],payload:JSON.stringify({id:'x',event:'task.status_changed',data:{summary:'PAY-12: status In Progress → Done'}}),responseSnippet:'Internal Server Error'};
   else if(ep==='/api/v1/projects')data={items:projects,page:1,totalPages:1,totalItems:2};
   else if(ep==='/api/v1/incoming-webhooks')data=incoming;
   else if(ep==='/api/v1/incoming-webhooks/i1/sample')data={sample};
   else if(ep==='/api/v1/incoming-webhooks/i1/events')data={items:[{id:'e1',receivedAt:iso(-2),status:'merged',title:'CoreBankingEOD on cbs-01',dedupeKey:'ab12',targetType:'ticket',targetId:'w1',targetKey:'WT-48',error:null,count:3},
     {id:'e2',receivedAt:iso(-9),status:'created',title:'CoreBankingEOD on cbs-01',dedupeKey:'ab12',targetType:'ticket',targetId:'w1',targetKey:'WT-48',error:null,count:3},
     {id:'e3',receivedAt:iso(-12),status:'rejected',title:null,dedupeKey:null,targetType:null,targetId:null,targetKey:null,error:'A request without the right secret or signature was refused.',count:null}],total:3,page:1,pageSize:50};
   else if(ep.endsWith('/workspace/members'))data=[{userId:user.id,displayName:user.displayName,email:user.email,role:'Owner',joinedAt:iso(-1000),jobRole:null}];
   else if(ep==='/api/v1/work-types')data=[{id:'wt1',name:'Incident',isActive:true}];
   else if(ep==='/api/v1/notifications/counts')data={unread:0,needsYou:0,forInfo:0,snoozed:0};
   else if(ep==='/api/v1/notifications')data={items:[],page:1,pageSize:20,totalPages:0,totalItems:0};
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep==='/api/v1/chat/projects/unread')data=[];
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(300);await page.screenshot({path:path.join(out,name)});};
 const waitWrite=async(test)=>{for(let i=0;i<40&&!writes.some(test);i++)await new Promise(r=>setTimeout(r,100));return writes.find(test);};
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 try{
 await page.goto(origin+'/preview-org/settings/webhooks');
 // The row shows its health and how close it is to switching off.
 const health=page.getByLabel('Health of Billing system');await health.waitFor();
 assert.match(await health.innerText(),/95% delivered · 120 in 7 days · 6 failed · 184 ms on average/);
 await page.getByText('3 deliveries in a row failed; it switches off after 10.').waitFor();
 checks.push('row-health');

 // Filters: only Payments, only High, status changes only to Done.
 await page.getByRole('button',{name:'Edit Billing system'}).click();
 const dialog=page.getByRole('dialog');
 await dialog.locator('.hook-filters > summary').click();
 await dialog.getByLabel('Payments').check();
 await dialog.getByLabel('High',{exact:true}).check();
 await dialog.getByLabel('Status changes only to').fill('Done, Blocked');
 await dialog.getByRole('button',{name:'Save webhook'}).click();
 const put=await waitWrite(w=>w.ep==='/api/v1/webhooks/h1'&&w.method==='PUT');
 assert.deepEqual(put.b.filterProjects,[pay]);assert.deepEqual(put.b.filterPriorities,['High']);assert.deepEqual(put.b.filterStatuses,['Done','Blocked']);
 await page.getByText('Filtered: projects Payments · priority High · status changes to Done or Blocked').waitFor();
 checks.push('filters');

 // Deliveries & health: KPIs, day bars, the history a page at a time, one delivery in full, send again, and a replay window.
 await page.getByRole('button',{name:'Deliveries & health'}).click();
 const modal=page.getByRole('dialog');
 await modal.getByLabel('Health in the last 7 days').getByText('95%',{exact:true}).waitFor();
 assert.ok(await modal.getByText('95% under 420 ms').isVisible());
 const list=modal.getByRole('list',{name:'Deliveries'});await list.waitFor();
 assert.equal(await list.getByRole('listitem').count(),25);
 await modal.getByText('Page 1 of 2').waitFor();
 await modal.getByRole('button',{name:'Older'}).click();await modal.getByText('Page 2 of 2').waitFor();
 assert.equal(await list.getByRole('listitem').count(),5);
 await modal.getByRole('button',{name:'Newer'}).click();await modal.getByText('Page 1 of 2').waitFor();
 const failed=list.getByRole('listitem').first();
 await failed.getByRole('button',{name:'View'}).click();
 await failed.getByText('Internal Server Error').waitFor();
 assert.match(await failed.locator('pre').first().innerText(),/"event": "task.status_changed"/);
 await failed.getByRole('button',{name:'Send again'}).click();
 assert.ok(await waitWrite(w=>w.ep.endsWith('/deliveries/d0/replay')));
 await modal.locator('.hook-replay > summary').click();
 await modal.getByRole('button',{name:'Send these again'}).click();
 const many=await waitWrite(w=>w.ep==='/api/v1/webhooks/h1/replay');
 assert.equal(many.b.onlyFailed,true);assert.ok(new Date(many.b.to)>new Date(many.b.from));
 await page.getByText('2 events queued to send again.').waitFor();
 await shot(page,'deliveries-1440.png');
 await modal.getByRole('button',{name:'Close'}).last().click();
 checks.push('history-replay');

 // Event explorer: a sample for each event and a test of one.
 const explorer=page.getByTestId('event-explorer');
 await explorer.getByRole('button',{name:'reported'}).click();
 assert.match(await explorer.getByLabel('Sample payload').innerText(),/Wrong EMI on statement/);
 await explorer.getByRole('button',{name:'Send a test of this event'}).click();
 const test=await waitWrite(w=>w.ep.endsWith('/h1/test'));
 assert.deepEqual(test.b,{event:'issue.reported'});
 checks.push('explorer');

 // Incoming: a new address for tickets, its URL and secret once, then the mapping set by example.
 const inc=page.getByTestId('incoming-webhooks');
 await inc.getByText('No incoming addresses').waitFor();
 await inc.getByRole('button',{name:'New address'}).click();
 const nd=page.getByRole('dialog');
 await nd.getByLabel('Name').fill('Grafana alerts');
 await nd.getByRole('combobox',{name:'Project'}).click();await page.getByRole('option',{name:'Payments'}).click();
 await nd.getByRole('combobox',{name:'Merge repeats'}).click();await page.getByRole('option',{name:'Within an hour'}).click();
 await nd.getByRole('button',{name:'Create the address'}).click();
 const made=await waitWrite(w=>w.ep==='/api/v1/incoming-webhooks'&&w.method==='POST');
 assert.equal(made.b.target,'ticket');assert.equal(made.b.projectId,pay);assert.equal(made.b.mergeMinutes,60);assert.equal(made.b.requireSecret,true);
 const addr=page.getByRole('dialog');
 await addr.getByText('whsec_synthetic_secret_value',{exact:true}).waitFor();
 assert.ok(await addr.getByText('/api/v1/hooks/in/0123456789abcdef',{exact:false}).first().isVisible());
 await addr.getByRole('button',{name:'Set the mapping'}).click();
 const map=page.getByRole('dialog');
 await map.getByLabel('Example request').fill(sample);
 await map.getByRole('button',{name:'Guess the mapping'}).click();
 await map.getByTestId('mapping-preview').getByText('CoreBankingEOD on cbs-01').waitFor();
 assert.equal(await map.getByLabel('What makes a repeat').inputValue(),'{{alerts.0.fingerprint}}');
 // Click a value to put it in the details template.
 await map.getByLabel('Details').click();
 await map.getByRole('list',{name:'Values in the example'}).getByRole('listitem').filter({hasText:'alerts.0.labels.severity'}).click();
 assert.equal(await map.getByLabel('Details').inputValue(),'{{alerts.0.labels.severity}}');
 await map.getByRole('button',{name:'Add a priority word'}).click();
 await map.getByLabel('Source priority').fill('sev-a');
 await shot(page,'mapping-1440.png');
 await map.getByRole('button',{name:'Save mapping'}).click();
 const saved=await waitWrite(w=>w.ep==='/api/v1/incoming-webhooks/i1'&&w.method==='PUT');
 assert.equal(saved.b.mapping.title,'{{alerts.0.labels.alertname}} on {{alerts.0.labels.instance}}');
 assert.deepEqual(saved.b.mapping.priorityMap,{'sev-a':'High'});
 checks.push('incoming-mapping');

 // Requests: what each became.
 await inc.getByText('3 received · 1 raised · 2 merged',{exact:false}).waitFor();
 await inc.getByRole('button',{name:'Requests'}).click();
 const reqs=page.getByRole('dialog').getByRole('list',{name:'Requests'});await reqs.waitFor();
 assert.ok(await reqs.getByText('WT-48 · seen 3 times',{exact:false}).first().isVisible());
 assert.ok(await reqs.getByText('rejected').isVisible());
 await page.getByRole('dialog').getByRole('button',{name:'Close'}).last().click();
 checks.push('requests');

 // Phone.
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
 await fitsPhone(page,'webhooks',assert);
 await page.screenshot({path:path.join(out,'webhooks-390.png'),fullPage:true});
 checks.push('phone');
 assert.deepEqual(errors,[]);
 }catch(e){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.log('URL:',page.url());console.log('errors:',errors);throw e;}
 console.log('webhooks ui ok:',checks.join(', '));
 await ctx.close();
}finally{await browser.close();}
