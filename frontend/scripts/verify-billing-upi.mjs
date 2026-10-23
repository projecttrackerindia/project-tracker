import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Paying for a plan by UPI QR, against the built frontend and synthetic API fixtures only: the QR, "Try another QR", the UTR, and the
// administrator's confirmation. No live payments.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/billing-upi');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Alex Morgan',email:'owner@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'FREE',memberCount:2};
const plans=[
 {id:'p0',code:'FREE',name:'Free',description:'One person',priceMonthly:0,currency:'INR',features:{PROJECT_LIMIT:3,TASK_LIMIT:100,MAX_MEMBERS:1,MAX_TEAMS:1,STORAGE_LIMIT_MB:100,MAX_FILE_SIZE_MB:10,ACTIVITY_RETENTION_DAYS:30,AI_MONTHLY_CREDITS:20,AI_MODEL_TIER:1,AI_ASSISTANT:1},isCurrent:true,sortOrder:0},
 {id:'p1',code:'BUSINESS',name:'Business',description:'For teams',priceMonthly:499,currency:'INR',features:{PROJECT_LIMIT:-1,TASK_LIMIT:-1,MAX_MEMBERS:-1,MAX_TEAMS:-1,STORAGE_LIMIT_MB:5120,MAX_FILE_SIZE_MB:100,ACTIVITY_RETENTION_DAYS:-1,AI_MONTHLY_CREDITS:200,AI_MODEL_TIER:2,AI_ASSISTANT:2,ADVANCED_REPORTS:1},isCurrent:false,sortOrder:1,perSeat:true},
];
const accounts=[['first@okbank','Bank A'],['second@axl','Bank B'],['third@ybl','Bank C']];
let attempt=0,upi=null,planCode='FREE';
const pay=(st='awaiting')=>{const [id,label]=accounts[attempt];return {id:`u${attempt}`,reference:`PT-ABC12${attempt}`,amount:998,currency:'INR',description:'Business, 2 users, monthly',planCode:'BUSINESS',payeeName:'Test Payee',upiId:id,bankLabel:label,
 upiUri:`upi://pay?pa=${encodeURIComponent(id)}&pn=Test%20Payee&am=998.00&cu=INR&tn=Project%20Tracker%20PT-ABC12${attempt}`,status:st,utr:null,attempt:attempt+1,otherQrAvailable:attempt<2,expiresAt:'2030-01-08T05:00:00Z',createdAt:'2030-01-06T05:00:00Z',decisionNote:null};};
const overview=()=>({plan:{code:planCode,name:planCode==='FREE'?'Free':'Business',status:'Active',trialEnd:null,periodEnd:planCode==='FREE'?null:'2030-02-06T05:00:00Z',cancelAtPeriodEnd:false,downgraded:false},
 usage:[{key:'MAX_MEMBERS',label:'Members',used:2,limit:planCode==='FREE'?1:-1}],invoices:planCode==='FREE'?[]:[{id:'i1',number:'INV-1',planCode:'BUSINESS',amount:998,currency:'INR',status:'Paid',description:'Business',issuedAt:'2030-01-06T06:00:00Z'}],
 trialAvailable:false,plans:plans.map(p=>({...p,isCurrent:p.code===planCode})),canManage:true,paymentProvider:'upi',payment:null,seats:{perSeat:planCode!=='FREE',purchased:2,inUse:2,period:'monthly',renewal:null},policy:null,upi});
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  const body=()=>{try{return req.postDataJSON();}catch{return null;}};
  if(ep==='/api/v1/billing/checkout'&&method==='POST'){const b=body();writes.push({ep,b});upi=pay();data=overview();}
  else if(ep.match(/\/billing\/upi\/u\d\/failed$/)){const b=body();writes.push({ep,b});attempt++;upi=pay();data=upi;}
  else if(ep.match(/\/billing\/upi\/u\d\/paid$/)){const b=body();writes.push({ep,b});upi={...upi,status:'submitted',utr:b.utr};data=upi;}
  else if(ep==='/api/v1/billing')data=overview();
  else if(ep==='/api/v1/billing/details')data={name:'',address:'',taxId:''};
  else if(ep==='/api/v1/admin/upi-payments'){data=upi?.status==='submitted'?[{id:upi.id,tenantId:ws.id,workspace:ws.name,planCode:'BUSINESS',seats:2,period:'monthly',amount:998,currency:'INR',reference:upi.reference,upiId:upi.upiId,bankLabel:upi.bankLabel,status:'submitted',utr:upi.utr,attempt:upi.attempt,failureReason:null,createdAt:'2030-01-06T05:00:00Z',submittedAt:'2030-01-06T05:10:00Z',submittedByEmail:user.email,decidedAt:null,decisionNote:null}]:[];}
  else if(ep==='/api/v1/admin/upi-accounts')data=accounts.map(([id,label],i)=>({upiId:id,bankLabel:label,enabled:true,inUse:i===1,recentFailures:i===0?3:0,confirmed:i===2?1:0,lastConfirmedAt:i===2?'2030-01-06T06:00:00Z':null,lastFailedAt:i===0?'2030-01-06T05:05:00Z':null}));
  else if(ep.match(/\/admin\/upi-payments\/u\d\/confirm$/)){const b=body();writes.push({ep,b});planCode='BUSINESS';upi={...upi,status:'confirmed'};data={};}
  else{
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','org.manage','billing.manage','billing.view'],modules:{projects:3,billing:3},plan:{code:planCode,name:'Free',status:'Active'},entitlements:{}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep.endsWith('/projects')||ep.endsWith('/tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 const noOverflow=(page,what)=>fitsPhone(page,what,assert);

 let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.log('console:',m.text().slice(0,400));});await page.setViewportSize({width:1440,height:1100});
 await page.goto(origin+'/preview-org/settings/billing');
 await page.getByRole('heading',{name:'Current plan'}).waitFor({timeout:8000}).catch(async e=>{await page.screenshot({path:path.join(out,'fail.png')});console.log(page.url(),errors);throw e;});
 await page.locator('.plan-card').filter({hasText:'Business'}).getByRole('button').first().click();
 await page.getByRole('dialog').getByText(/scanning a UPI QR/).waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'Confirm'}).click();
 const card=page.locator('[data-upi=awaiting]');await card.waitFor();
 await card.locator('.upi-qr img').waitFor();
 assert.ok(await card.getByText('first@okbank').isVisible());assert.ok(await card.getByText('Bank A').isVisible());
 assert.equal(writes[0].b.planCode,'BUSINESS');checks.push('qr-shown');
 await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(600);await card.screenshot({path:path.join(out,'upi-qr-1440.png'),animations:'disabled'});
 await noOverflow(page,'billing 1440');

 await card.getByRole('button',{name:'Payment failed? Try another QR'}).click();
 await card.getByLabel('What happened?').selectOption('The bank server is down');
 await card.getByRole('button',{name:'Show another QR'}).click();
 await page.locator('[data-upi=awaiting]').getByText('second@axl').waitFor();
 assert.deepEqual(writes.at(-1).b,{reason:'The bank server is down'});checks.push('switch-qr');

 const c2=page.locator('[data-upi=awaiting]');
 assert.equal(await c2.getByRole('button',{name:'I have paid'}).isDisabled(),true);
 await c2.getByLabel(/UPI transaction id/).fill('4123 5678 9012');
 await c2.getByRole('button',{name:'I have paid'}).click();
 await page.locator('[data-upi=submitted]').waitFor();
 assert.deepEqual(writes.at(-1).b,{utr:'412356789012'});checks.push('utr-submitted');
 await page.screenshot({path:path.join(out,'upi-submitted-1440.png'),animations:'disabled'});

 // Phone width: the QR and the "Open in UPI app" button fit.
 await page.close();attempt=1;upi=pay();
 page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/settings/billing');await page.locator('[data-upi=awaiting] .upi-qr img').waitFor();
 await page.locator('[data-upi=awaiting]').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(out,'upi-qr-390.png'),animations:'disabled'});
 await noOverflow(page,'billing 390');checks.push('phone');
 await page.locator('[data-upi=awaiting]').getByLabel(/UPI transaction id/).fill('412356789099');
 await page.locator('[data-upi=awaiting]').getByRole('button',{name:'I have paid'}).click();await page.locator('[data-upi=submitted]').waitFor();
 await page.close();

 // The administrator confirms.
 user.isPlatformAdmin=true;
 page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/admin/payments');
 await page.getByRole('heading',{name:'UPI accounts'}).waitFor();
 const row=page.locator('[data-upi-row=submitted]');await row.waitFor();
 assert.ok(await row.getByText('412356789099').isVisible());
 assert.ok(await page.getByText('Shown first').isVisible());
 await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,'admin-payments-1440.png'),animations:'disabled',fullPage:true});
 await row.getByRole('button',{name:'Confirm'}).click();
 await page.getByRole('dialog').getByRole('textbox').fill('Seen in the statement');
 await page.getByRole('dialog').getByRole('button',{name:'Confirm and switch on the plan'}).click();
 await page.getByText('Nothing to confirm').waitFor();
 assert.deepEqual(writes.at(-1).b,{note:'Seen in the statement'});checks.push('admin-confirm');
 await noOverflow(page,'admin payments');
 await page.close();

 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,writes:writes.length,errors,scope:'Built frontend with synthetic fixtures; no live payments.'},null,2));
 console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
