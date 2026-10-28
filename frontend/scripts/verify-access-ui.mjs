import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// People and the audit log in the calm design: the directory's KPIs (members against seats, owners and admins, guests, invitations
// waiting) and role pills; the audit log's chain banner (intact or broken), "Verify chain", quick filters that ask the server for an action
// prefix, and actions coloured by what they did. Light, dark and a phone. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/access-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false,mfaEnabled:true};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:5};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const M=(n,name,role,jobRole=null)=>({userId:`00000000-0000-0000-0000-0000000001${n}0`,displayName:name,email:`${name.split(' ')[0].toLowerCase()}@example.test`,role,joinedAt:iso(-60*24*(40-n)),jobRole});
const members=[{...M(0,'Asha Rao','Owner','Platform lead'),userId:user.id},M(1,'Ravi Kumar','Admin','Security lead'),M(2,'Meena Iyer','Manager','Payments'),M(3,'Anita Das','Member','Developer'),M(4,'External Auditor','Guest')];
const invitations=[{id:'i1',email:'jo@example.test',role:'Member',status:'Pending',expiresAt:iso(60*24*5),createdAt:iso(-60*24),invitedBy:'Asha Rao',jobRole:null,reportsTo:null}];
const L=(n,action,userName,entityType,mins,oldValue=null,newValue=null)=>({id:`a${n}`,tenantId:ws.id,tenantName:null,userId:null,userName,action,entityType,entityId:null,oldValue,newValue,ipAddress:userName?'49.37.12.9':null,createdAt:iso(-mins)});
const logs=[L(1,'vault.item.copied','Anita Das','VaultItem',8,null,'Payments DB · password'),L(2,'member.invited','Asha Rao','Member',20,null,'jo@example.test'),L(3,'vault.item.deleted','Ravi Kumar','VaultItem',40,'Old router',null),
  L(4,'document.published','Meena Iyer','Document',90,null,'Loan Service API v3.2'),L(5,'org.access.approved','Asha Rao','AccessRequest',120,null,'Anita → Payments DB, 2 hours'),L(6,'user.signin.failed',null,'User',200)];
let chain={intact:true,records:1284,verifiedUpTo:1284,verifiedAt:iso(-60*6),brokenSeq:null,brokenId:null,reason:null};
const writes=[],errors=[],checks=[],auditQueries=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');if(!localStorage.getItem('pm_theme'))localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  if(ep==='/api/v1/document-security/verify-audit'&&method==='POST'){writes.push({ep});data={...chain,verifiedAt:iso(0)};}
  else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
  else{
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','tasks.view','org.manage','reports.view','work.view','members.invite','members.manage','audit.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3,members:3,audit:3,organization:3,teams:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3,ADVANCED_SECURITY:1,MAX_MEMBERS:25}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/workspace/members')data=members;
   else if(ep==='/api/v1/workspace/invitations')data=invitations;
   else if(ep==='/api/v1/audit-logs'){const a=url.searchParams.get('action')??'';auditQueries.push(a);const items=logs.filter(l=>l.action.startsWith(a));data={items,page:1,totalPages:1,totalItems:items.length};}
   else if(ep==='/api/v1/document-security')data={revealSeconds:15,entitled:true,keyVersion:1,valuesTotal:0,valuesOnOldKeys:0,lastRotatedAt:null,chain};
   else if(ep==='/api/v1/settings/changes')data={items:[],canUndo:true};
   else if(ep==='/api/v1/notifications/counts')data={unread:0,needsYou:0,forInfo:0,snoozed:0};
   else if(ep==='/api/v1/notifications')data={items:[],page:1,pageSize:20,totalPages:0,totalItems:0};
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
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(350);await page.screenshot({path:path.join(out,name),fullPage:false});};
 const waitWrite=async(test)=>{for(let i=0;i<40&&!writes.some(test);i++)await new Promise(r=>setTimeout(r,100));return writes.find(test);};
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});

 // People: KPIs from the real list (5 members of 25 seats, 2 owners/admins, 1 guest, 1 invitation waiting) and role pills.
 await page.goto(origin+'/preview-org/people');
 const kpis=page.getByTestId('people-kpis');await kpis.waitFor();
 await page.waitForFunction(()=>/Invitations waiting\s*1/.test(document.querySelector('[data-testid="people-kpis"]')?.innerText??''));
 const kpiText=(await kpis.innerText()).replace(/\s+/g,' ');
 for(const t of ['Members 5','of 25 seats','Owners and admins 2','Guests 1','Invitations waiting 1'])assert.ok(kpiText.includes(t),`KPI "${t}" in: ${kpiText}`);
 // People & Roles: access levels are pills on each person's row (owner dark, guest amber).
 assert.ok(await page.locator('.pr-level.lv-owner',{hasText:'Owner'}).first().isVisible());
 assert.ok(await page.locator('[data-testid="person-row"]',{hasText:'External Auditor'}).locator('.pr-level.lv-guest',{hasText:'Guest'}).isVisible());
 await shot(page,'people-1440.png');
 await kpis.getByRole('link',{name:/Invitations waiting/}).click();
 await page.waitForURL(/\/people\/invitations$/);await page.getByText('jo@example.test').waitFor();
 checks.push('people-kpis','role-pills','kpi-link');

 // Audit log: the chain is intact; Verify chain asks the server again; the quick filters ask for an action prefix.
 await page.goto(origin+'/preview-org/settings/audit');
 const banner=page.getByTestId('chain-banner');await banner.waitFor();
 assert.match(await banner.innerText(),/Chain intact · 1,284 events/);
 await page.getByRole('button',{name:'Verify chain'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/document-security/verify-audit'));
 await page.getByText('The audit trail is intact.').first().waitFor();
 assert.equal(await page.locator('.audit-action.t-danger',{hasText:'vault.item.deleted'}).count(),1);
 assert.equal(await page.locator('.audit-action.t-warning',{hasText:'vault.item.copied'}).count(),1);
 assert.equal(await page.locator('.audit-action.t-success',{hasText:'org.access.approved'}).count(),1);
 await shot(page,'audit-1440.png');
 await page.getByRole('group',{name:'Show'}).getByRole('button',{name:'Vault'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.audit-card tbody tr').length===2);
 assert.ok(auditQueries.includes('vault'));
 assert.equal(await page.getByRole('group',{name:'Show'}).getByRole('button',{name:'Vault'}).getAttribute('aria-pressed'),'true');
 checks.push('chain-banner','verify-chain','audit-filters','action-tones');

 // A broken chain says which record.
 chain={...chain,intact:false,brokenSeq:907,reason:'A record was changed'};
 await page.reload();await page.getByTestId('chain-banner').waitFor();
 assert.match(await page.getByTestId('chain-banner').innerText(),/failed its tamper check[\s\S]*record 907/);
 chain={...chain,intact:true,brokenSeq:null,reason:null};
 checks.push('chain-broken');

 // Dark.
 await page.evaluate(()=>localStorage.setItem('pm_theme','dark'));
 await page.goto(origin+'/preview-org/settings/audit');await page.getByTestId('chain-banner').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.getAttribute('data-theme')),'dark');
 await shot(page,'audit-dark-1440.png');
 await page.goto(origin+'/preview-org/people');await page.getByTestId('people-kpis').waitFor();
 await shot(page,'people-dark-1440.png');
 checks.push('dark');

 // Phone.
 await page.evaluate(()=>localStorage.setItem('pm_theme','light'));
 await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/people');await page.getByTestId('people-kpis').waitFor();await page.waitForTimeout(300);
 await fitsPhone(page,'people directory',assert);await shot(page,'people-390.png');
 await page.goto(origin+'/preview-org/settings/audit');await page.getByTestId('chain-banner').waitFor();await page.waitForTimeout(300);
 await fitsPhone(page,'audit log',assert);await shot(page,'audit-390.png');
 checks.push('phone');

 assert.deepEqual(errors,[]);
 console.log('access ui ok:',checks.join(', '));
 await ctx.close();
}finally{await browser.close();}
