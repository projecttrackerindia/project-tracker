import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Reminders page (design: PDF p12): the floating "Remind me" input with suggestion chips that fill it, four KPIs, the segmented
// Upcoming / Completed / Watching control with filter chips, grouped white cards, adding in plain words, and the empty state - in light,
// dark and on a phone. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/reminders-ui');
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
  R('rm2','Submit my timesheet','Scheduled',{nextFireAt:(()=>{const d=new Date();d.setDate(d.getDate()+1);d.setHours(12,0,0,0);return d.toISOString();})(),recurrence:'FREQ=WEEKLY;BYDAY=FR',recurrenceText:'Every Friday'}),
  R('rm3','Review the release notes','Scheduled',{source:'DueDate',nextFireAt:iso(60*50),targetType:'Task',targetId:'t1',targetKey:'PAY-12',targetTitle:'Release notes',link:'/tasks/t1'}),
  R('rm4','Send Meena the vendor contract','Scheduled',{source:'Nudge',nextFireAt:iso(60*24*4),from:{id:'u2',name:'Ravi Kumar'}}),
 ],
 completed:[R('rm9','Book the UAT room','Done',{completedAt:iso(-90)}),R('rm8','Share the sprint plan','Done',{completedAt:iso(-60*26)})],
 sent:[],counts:{now:1,today:0,upcoming:3,completed:2},limits:{open:500,recurring:100,openUsed:4,recurringUsed:1},
};
const empty={open:[],completed:[],sent:[],counts:{now:0,today:0,upcoming:0,completed:0},limits:{open:500,recurring:100,openUsed:0,recurringUsed:0}};
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async(theme,list)=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  await ctx.addInitScript((t)=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme',t);localStorage.setItem('pm_home_mode','classic');},theme);
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[];
   if(ep==='/api/v1/reminders'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={...R('new',b.title,'Scheduled',{nextFireAt:b.when?.at??null})};}
   else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','tasks.view','org.manage','reports.view','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
    else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
    else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
    else if(ep==='/api/v1/reminders')data=list;
    else if(ep==='/api/v1/reminders/settings')data={defaultTime:'09:00',timeZone:'Asia/Kolkata'};
    else if(ep==='/api/v1/reminders/suggestions')data=[];
    else if(ep==='/api/v1/ai/watches')data=[];
    else if(ep==='/api/v1/reminders/insights')data=list===empty?{doneThisWeek:0,firedThisWeek:0,onTimePercent:0,usualTime:'12:00',snoozedOften:[]}:{doneThisWeek:2,firedThisWeek:3,onTimePercent:86,usualTime:'12:00',snoozedOften:[]};
    else if(ep==='/api/v1/reminders/counts')data=list.counts;
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
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);await page.screenshot({path:path.join(out,name),fullPage:true});};

 // Light, desktop, with reminders.
 let ctx=await make('light',full);let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/reminders');await page.locator('.rp-card').first().waitFor();
 assert.equal(await page.locator('.page-title').innerText(),'Reminders');
 assert.match(await page.locator('.page-sub').innerText(),/^Times in Asia\/Kolkata\.$/);
 const kv=await page.locator('.rp-kpi .v').allInnerTexts(),kl=await page.locator('.rp-kpi .l').allInnerTexts();
 assert.deepEqual(kl,['Need attention','Still today','Completed','Your usual time']);assert.deepEqual([kv[0],kv[2],kv[3]],['1','2','12:00']);
 assert.ok(await page.locator('.rp-kpi.danger').count()===1,'something waiting shows its count in red');
 assert.equal(await page.getByRole('tab',{name:'Upcoming'}).getAttribute('aria-selected'),'true');
 assert.equal(await page.getByRole('tab',{name:'Completed · 2'}).count(),1);
 assert.deepEqual(await page.locator('.rp-group h3').allInnerTexts().then(t=>t.map(x=>x.replace(/\s+\d+$/,''))),['Needs attention','Tomorrow','Next 7 days']);
 checks.push('layout');
 await shot(page,'reminders-1440.png');

 // A suggestion chip fills the input; Add sets it (plain words, parsed here).
 await page.getByRole('button',{name:'Every Friday 4pm submit my timesheet'}).click();
 assert.equal(await page.locator('#rp-quick-input').inputValue(),'Every Friday 4pm submit my timesheet');
 await page.locator('.rp-quick-parse b').waitFor();
 await page.locator('.rp-quick button[type=submit]').click();
 for(let i=0;i<40&&!writes.length;i++)await page.waitForTimeout(100);
 assert.equal(writes[0]?.b.title.toLowerCase(),'submit my timesheet');assert.match(writes[0].b.when.recurrence,/FREQ=WEEKLY/);
 checks.push('quick-add-from-chip');

 // Filter chips: dark when chosen; From others shows only the nudge.
 await page.getByRole('button',{name:'From others'}).click();
 assert.equal(await page.getByRole('button',{name:'From others'}).getAttribute('aria-pressed'),'true');
 assert.deepEqual(await page.locator('.rp-card .rp-title').allInnerTexts(),['Send Meena the vendor contract']);
 await page.getByRole('button',{name:'All',exact:true}).click();checks.push('filters');

 // Completed through the segmented control.
 await page.getByRole('tab',{name:'Completed · 2'}).click();
 await page.locator('.rp-card.is-done').first().waitFor();
 assert.equal(await page.locator('.rp-card.is-done').count(),2);
 assert.equal(await page.locator('.ds-seg-thumb').count(),1,'the thumb glides under the chosen view');
 await shot(page,'reminders-completed-1440.png');checks.push('completed');
 await ctx.close();

 // Dark, desktop.
 ctx=await make('dark',full);page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/reminders');await page.locator('.rp-card').first().waitFor();
 await shot(page,'reminders-dark-1440.png');checks.push('dark');
 // Tablet.
 await page.setViewportSize({width:820,height:1100});await shot(page,'reminders-dark-820.png');
 await ctx.close();

 // Empty, light, desktop: "Nothing coming up".
 ctx=await make('light',empty);page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 await page.goto(origin+'/preview-org/reminders');await page.locator('.rp-empty-card').waitFor();
 assert.equal(await page.locator('.rp-empty-card h4').innerText(),'Nothing coming up');
 await shot(page,'reminders-empty-1440.png');checks.push('empty');
 // The Add button with nothing typed opens the full form.
 await page.locator('.rp-quick button[type=submit]').click();
 await page.locator('.modal').first().waitFor();checks.push('add-opens-form');
 await ctx.close();

 // Phone, light and dark.
 for(const theme of ['light','dark']){
  ctx=await make(theme,full);page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/preview-org/reminders');await page.locator('.rp-card').first().waitFor();
  await fitsPhone(page,`reminders ${theme}`,assert);
  await shot(page,`reminders-${theme}-390.png`);
  await ctx.close();
 }
 checks.push('phone');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
