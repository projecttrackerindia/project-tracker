import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';

// Platform › System health: the "Real-user speed" card (75th percentile per page, by measure and device), and the app's own
// telemetry: it asks /telemetry/config and sends its speed beacon to /telemetry/vitals when the page is hidden. Light, dark, phone.
// Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/speed-ui');
await fs.mkdir(out,{recursive:true});
const csp=await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:true,mfaEnabled:true};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:5};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const R=(page,device,metric,p75,rating,count)=>({page,device,metric,p75,rating,count});
const vitals={days:7,samples:0,rows:[R('/projects/:id/board','mobile','LCP',4600,'poor',120),R('/projects/:id/board','desktop','LCP',1900,'good',340),R('/my-work','desktop','LCP',1200,'good',810),
  R('/my-work','mobile','LCP',2900,'needs-improvement',260),R('/inbox','desktop','LCP',1600,'good',150),R('/reports','desktop','LCP',3300,'needs-improvement',40),R('/my-work','desktop','INP',140,'good',700),R('/projects/:id/board','mobile','INP',420,'needs-improvement',90)]};
vitals.samples=vitals.rows.reduce((a,r)=>a+r.count,0);
const health={status:'ok',version:'1.0',runtime:'.NET 9',uptimeSeconds:86400,startedAt:new Date().toISOString(),attachmentStorageMb:12,traffic:{requests:1000,serverErrors:0,clientErrors:0,lastServerErrorAt:null},
  database:{reachable:true,provider:'Postgres',latencyMs:3,pendingMigrations:0,error:null},cache:{reachable:true,provider:'Redis',latencyMs:1,error:null},
  queues:{emailsWaiting:0,emailsStuck:0,reportsWaiting:0,reportsFailed:0,webhooksWaiting:0,webhooksFailed:0},reminders:null,workers:[]};
const errors=[],beacons=[];let configAsked=0;
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');if(!localStorage.getItem('pm_theme'))localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');window.__ptVitals=true;});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file).catch(()=>''),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  if(ep==='/api/v1/telemetry/config'){configAsked++;data={errors:false,release:'abc1234',vitals:true};}
  else if(ep==='/api/v1/telemetry/vitals'&&method==='POST'){beacons.push({body:req.postDataJSON(),auth:req.headers()['authorization']});data={kept:1};}
  else if(ep==='/api/v1/telemetry/vitals'){assert.equal(url.searchParams.get('all'),'true');data=vitals;}
  else if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
  else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','org.manage'],modules:{projects:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{}}};
  else if(ep==='/api/v1/admin/health')data=health;
  else if(ep==='/api/v1/admin/go-live')data={ready:true,checks:[]};
  else if(ep==='/api/v1/admin/meeting-bots')data=null;
  else if(ep==='/api/v1/notifications/counts')data={unread:0,needsYou:0,forInfo:0,snoozed:0};
  else if(ep==='/api/v1/notifications')data={items:[],page:1,pageSize:20,totalPages:0,totalItems:0};
  else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
  else if(ep==='/api/v1/timer')data=null;
  else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  else if(method!=='GET')data={};
  else data=null;
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 await page.goto(origin+'/admin/health');
 const card=page.locator('.speed-card');await card.waitFor({timeout:20000});
 await card.scrollIntoViewIfNeeded();
 // LCP across all devices: the slowest device class decides, so the board (slow on phones) comes first and says Poor.
 const first=card.locator('.speed-row').first();
 assert.match(await first.innerText(),/\/projects\/:id\/board[\s\S]*4\.6 s[\s\S]*Poor/);
 assert.equal(await card.locator('.speed-row').count(),4);
 await card.screenshot({path:path.join(out,'speed-1440.png')});
 await card.getByRole('tab',{name:'Desktop'}).click();
 assert.match(await card.locator('.speed-row').first().innerText(),/\/reports[\s\S]*3\.3 s/);
 await card.getByRole('tab',{name:'Response'}).click();
 assert.match(await card.locator('.speed-row').first().innerText(),/\/my-work[\s\S]*140 ms[\s\S]*Good/);
 // Dark mode.
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
 await card.getByRole('tab',{name:'All'}).click();await card.getByRole('tab',{name:'Load'}).click();
 await card.screenshot({path:path.join(out,'speed-dark-1440.png')});
 // The page's own speed beacon: sent once, signed-in, with a page pattern and no query string.
 assert.ok(configAsked>=1,'telemetry config asked');
 await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
 for(let i=0;i<30&&beacons.length===0;i++)await page.waitForTimeout(100);
 const b=beacons[0];assert.ok(b,'a vitals beacon was sent');
 assert.equal(b.body.page,'/admin/health');assert.ok(['mobile','tablet','desktop'].includes(b.body.device));assert.ok(b.auth?.startsWith('Bearer '));
 assert.ok(b.body.metrics.some(m=>m.name==='TTFB'||m.name==='FCP'),JSON.stringify(b.body));
 // Phone.
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
 const phone=await ctx.newPage();phone.on('pageerror',e=>errors.push(e.message));await phone.setViewportSize({width:390,height:844});
 await phone.goto(origin+'/admin/health');const pc=phone.locator('.speed-card');await pc.waitFor({timeout:20000});await pc.scrollIntoViewIfNeeded();
 // The rest of System health has its own (older) phone layout; this checks the speed card and everything in it.
 const over=await pc.evaluate(el=>[el,...el.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>innerWidth+1&&!e.closest('[role=tablist]')}).map(e=>e.className).slice(0,5));
 assert.deepEqual(over,[],'speed card fits a phone');
 assert.equal(await pc.locator('.speed-row').count(),4);
 await pc.screenshot({path:path.join(out,'speed-390.png')});
 assert.deepEqual(errors,[]);
 console.log('verify-speed-ui: ok', out);
}finally{await browser.close();}
