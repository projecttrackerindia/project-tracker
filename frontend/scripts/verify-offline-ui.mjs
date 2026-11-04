import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Offline mode (phone first): an edit made with no connection waits in the outbox (calm offline pill, optimistic UI),
// is sent on reconnect and persists; a version conflict gives way to the server with a "changed elsewhere" notice. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/offline-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const R=(id,title,state,extra)=>({id,source:'Personal',state,title,note:null,targetType:'None',targetId:null,targetKey:null,targetTitle:null,link:null,timeZone:'Asia/Kolkata',localAt:null,anchorDays:null,anchorTime:null,recurrence:null,recurrenceText:null,onlyIfOpen:false,exact:false,nextFireAt:null,isSnoozed:false,snoozeCount:0,fireCount:0,lastFiredAt:null,quiet:false,completedAt:null,seriesId:null,from:null,for:null,canEdit:true,createdAt:iso(-600),...extra});
const full={
 open:[
  R('rm1','Call the bank about the EMI file','Fired',{lastFiredAt:iso(-20),fireCount:1}),
  R('rm2','Submit my timesheet','Scheduled',{nextFireAt:(()=>{const ist=new Date(Date.now()+330*60000);return new Date(Date.UTC(ist.getUTCFullYear(),ist.getUTCMonth(),ist.getUTCDate()+1,6,30)).toISOString();})()/* tomorrow noon in Kolkata, the page's zone */,recurrence:'FREQ=WEEKLY;BYDAY=FR',recurrenceText:'Every Friday'}),
  R('rm3','Review the release notes','Scheduled',{source:'DueDate',nextFireAt:iso(60*50),targetType:'Task',targetId:'t1',targetKey:'PAY-12',targetTitle:'Release notes',link:'/tasks/t1'}),
  R('rm4','Send Meena the vendor contract','Scheduled',{source:'Nudge',nextFireAt:iso(60*24*4),from:{id:'u2',name:'Ravi Kumar'}}),
 ],
 completed:[R('rm9','Book the UAT room','Done',{completedAt:iso(-90)}),R('rm8','Share the sprint plan','Done',{completedAt:iso(-60*26)})],
 sent:[],counts:{now:1,today:0,upcoming:3,completed:2},limits:{open:500,recurring:100,openUsed:4,recurringUsed:1},
};

const writes=[],errors=[],checks=[];
let state=JSON.parse(JSON.stringify(full));let conflictOn=null;let offline=false;
// Routed requests skip Playwright's offline emulation, so the mock refuses API calls itself while the device is offline.
const setOffline=async(ctx,v)=>{offline=v;await ctx.setOffline(v);};
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async(theme)=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  await ctx.addInitScript((t)=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme',t);localStorage.setItem('pm_home_mode','classic');},theme);
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(offline&&ep.startsWith('/api/')){await route.abort('internetdisconnected');return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[];
   const m=/^\/api\/v1\/reminders\/([^/]+)\/done$/.exec(ep);
   if(m&&method==='POST'){
    writes.push({ep,auth:req.headers()['authorization']});
    if(conflictOn===m[1]){await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({errors:[{code:'conflict',message:'Changed elsewhere'}]})});return;}
    const r=state.open.find(x=>x.id===m[1]);state.open=state.open.filter(x=>x.id!==m[1]);if(r){r.state='Done';r.completedAt=new Date().toISOString();state.completed.unshift(r);}data=r;
   }else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','tasks.view','org.manage','reports.view','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
    else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
    else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
    else if(ep==='/api/v1/reminders')data=state;
    else if(ep==='/api/v1/reminders/settings')data={defaultTime:'09:00',timeZone:'Asia/Kolkata'};
    else if(ep==='/api/v1/reminders/suggestions'||ep==='/api/v1/ai/watches')data=[];
    else if(ep==='/api/v1/reminders/insights')data={doneThisWeek:2,firedThisWeek:3,onTimePercent:86,usualTime:'12:00',snoozedOften:[]};
    else if(ep==='/api/v1/reminders/counts')data=state.counts;
    else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
    else if(ep==='/api/v1/timer')data=null;
    else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
    else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
    else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
    else if(ep==='/api/v1/chat/projects/unread')data=[];
    else if(ep==='/api/v1/notifications')data={items:[],page:1,pageSize:20,totalPages:0,totalItems:0};
    else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
   }
   await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
  });
  return ctx;};
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);await page.screenshot({path:path.join(out,name),fullPage:false});};
 const outboxSize=(page)=>page.evaluate(()=>new Promise(res=>{const r=indexedDB.open('pm-outbox',1);r.onupgradeneeded=()=>r.result.createObjectStore('q',{keyPath:'id'});r.onsuccess=()=>{const t=r.result.transaction('q','readonly').objectStore('q').getAll();t.onsuccess=()=>{res(t.result);r.result.close();};};}));

 for(const [theme,w,h] of [['light',390,844],['dark',1440,960]]){
  state=JSON.parse(JSON.stringify(full));writes.length=0;conflictOn=null;
  const ctx=await make(theme);const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:w,height:h});
  await page.goto(origin+'/preview-org/reminders');await page.locator('.rm-row').first().waitFor();
  // Offline: tick one reminder done.
  await setOffline(ctx,true);
  await page.locator('.offline-pill').waitFor();
  assert.match(await page.locator('.offline-pill').innerText(),/Offline/);
  await page.getByRole('button',{name:'Done: Call the bank about the EMI file'}).click();
  await page.locator('.offline-pill',{hasText:'1 edit will sync'}).waitFor();
  const queued=await outboxSize(page);
  assert.equal(queued.length,1);assert.equal(queued[0].path,'/reminders/rm1/done');
  assert.ok(!JSON.stringify(queued).includes(token),'the access token is never stored in the outbox');
  assert.equal(writes.length,0);
  await shot(page,`offline-${theme}-${w}.png`);
  if(w===390){const sx=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.ok(!sx,'no horizontal scroll on the phone');}
  // Reconnect: it is sent (with this session's token), the pill goes, and the edit persists after a reload.
  await setOffline(ctx,false);
  for(let i=0;i<60&&!writes.length;i++)await page.waitForTimeout(100);
  assert.equal(writes.length,1);assert.equal(writes[0].ep,'/api/v1/reminders/rm1/done');assert.equal(writes[0].auth,`Bearer ${token}`);
  await page.locator('.offline-pill').waitFor({state:'detached'});
  assert.equal((await outboxSize(page)).length,0);
  await page.reload();await page.locator('.rm-row, .rm-empty').first().waitFor();
  assert.ok(!(await page.locator('.rm-row:not(.dn)',{hasText:'Call the bank about the EMI file'}).count()),'the offline edit persisted');
  checks.push(`edit-offline-sync-${theme}`);
  // Conflict: server wins, with a calm notice.
  conflictOn='rm2';
  await page.getByRole('button',{name:/Scheduled/}).first().click();await page.getByRole('button',{name:'Done: Submit my timesheet'}).waitFor();
  await setOffline(ctx,true);await page.locator('.offline-pill').waitFor();
  await page.getByRole('button',{name:'Done: Submit my timesheet'}).click();
  await page.locator('.offline-pill',{hasText:'1 edit will sync'}).waitFor();
  await setOffline(ctx,false);
  await page.getByText(/changed elsewhere/).first().waitFor();
  assert.equal((await outboxSize(page)).length,0);
  checks.push(`conflict-${theme}`);
  await ctx.close();
 }
 assert.deepEqual(errors,[]);
 console.log('offline ui ok:',checks.join(', '));
}finally{await browser.close();}
