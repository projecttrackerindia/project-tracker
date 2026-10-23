import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';

// Account security: my sign-in history with "this wasn't me", the workspace's own sign-in rules, and the admin's view of members' account
// security with one-click reminders. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/security-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false,mfaEnabled:true};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
let signIns=[
 {id:'s1',at:iso(-30),lastSeenAt:iso(-1),device:'Chrome on Windows',network:'49.37.12.x',authMethod:'password+mfa',current:true,active:true,newDevice:false,reportedAt:null},
 {id:'s2',at:iso(-90),lastSeenAt:iso(-60),device:'Safari on iPhone',network:'198.51.100.x',authMethod:'password',current:false,active:true,newDevice:true,reportedAt:null},
 {id:'s3',at:iso(-60*30),lastSeenAt:iso(-60*29),device:'Firefox on Linux <b>x</b>',network:null,authMethod:'google',current:false,active:false,newDevice:false,reportedAt:null},
];
let security={requireMfa:false,ipAllowlistEnabled:false,ipRanges:[],myIp:'49.37.12.9',entitled:true,minPasswordLength:0,sessionHours:0,allowedSignIn:['password','passkey','google','microsoft','github','apple','sso'],platformMinPasswordLength:8};
const M=(userId,name,twoStep,len,issues,remindedAt=null)=>({userId,name,email:`${name.split(' ')[0].toLowerCase()}@example.test`,role:'Member',twoStep,passkeys:0,passwordChangedAt:iso(-60*24*30),passwordLength:len,lastSignInAt:iso(-120),issues,remindedAt});
let members={members:3,withoutTwoStep:2,weakPasswords:1,oldPasswords:0,people:[M('u1','Asha Rao',true,20,[]),M('u2','Ravi Kumar',false,10,['no-two-step','weak-password']),M('u3','Meena Iyer',false,16,['no-two-step'])]};
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  if(/^\/api\/v1\/me\/sign-ins\/s\d\/not-me$/.test(ep)&&method==='POST'){writes.push({ep});const id=ep.split('/')[5];signIns=signIns.map(s=>s.id===id?{...s,active:false,reportedAt:iso(0)}:s);await route.fulfill({status:204,body:''});return;}
  else if(ep==='/api/v1/workspace/security'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});security={...security,...b};data=security;}
  else if(ep==='/api/v1/settings/impact'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={kind:'security',headline:'Nobody is affected: everyone already meets the new rules.',people:0,affected:[],records:[],includesYou:false,warning:null,enforced:true,changes:['Passwords need at least 12 characters.']};}
  else if(ep==='/api/v1/settings/changes')data={items:[],canUndo:true};
  else if(ep==='/api/v1/workspace/security/remind'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});members={...members,people:members.people.map(p=>b.userIds.includes(p.userId)?{...p,remindedAt:iso(0)}:p)};data={sent:b.userIds.length};}
  else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
  else{
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','tasks.view','org.manage','reports.view','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3,ADVANCED_SECURITY:1}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/me/sign-ins')data=signIns;
   else if(ep==='/api/v1/me/sessions')data=signIns.filter(s=>s.active).map(s=>({id:s.id,createdAt:s.at,lastSeenAt:s.lastSeenAt,ipAddress:null,userAgent:s.device,isCurrent:s.current,authMethod:s.authMethod}));
   else if(ep==='/api/v1/me/mfa')data={enabled:true,recoveryCodesLeft:8};
   else if(ep==='/api/v1/me/passkeys')data=[];
   else if(ep==='/api/v1/me/logins')data=[];
   else if(ep==='/api/v1/workspace/security')data=security;
   else if(ep==='/api/v1/workspace/security/members')data=members;
   else if(ep==='/api/v1/workspace/project-visibility')data={mode:'organization',teams:0,peopleWithoutTeam:0};
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
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(300);await page.screenshot({path:path.join(out,name),fullPage:true});};
 const waitWrite=async(test)=>{for(let i=0;i<40&&!writes.some(test);i++)await new Promise(r=>setTimeout(r,100));return writes.find(test);};
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});

 // My sign-in history: the new iPhone is marked; "This wasn't me" ends it and offers the password change.
 await page.goto(origin+'/preview-org/account/security');
 const history=page.getByRole('list',{name:'Sign-in history'});await history.waitFor();
 assert.equal(await history.getByRole('listitem').count(),3);
 const iphone=history.getByRole('listitem').filter({hasText:'Safari on iPhone'});
 assert.ok(await iphone.getByText('New').isVisible());
 assert.ok(await history.getByText('Firefox on Linux <b>x</b>').isVisible());   // text stays text
 assert.equal(await history.getByRole('listitem').filter({hasText:'Chrome on Windows'}).getByRole('button',{name:"This wasn't me"}).count(),0);   // not this device
 await shot(page,'sign-ins-1440.png');
 await iphone.getByRole('button',{name:"This wasn't me"}).click();
 await page.getByRole('button',{name:'End it and secure my account'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/me/sign-ins/s2/not-me'));
 await history.getByRole('listitem').filter({hasText:'Safari on iPhone'}).getByText('Reported').waitFor();
 checks.push('not-me');

 // Workspace rules.
 await page.goto(origin+'/preview-org/settings/security');await page.getByRole('heading',{name:"Members' account security"}).waitFor();
 await page.getByRole('combobox',{name:'Minimum password length'}).click();await page.getByRole('option',{name:'At least 12'}).click();
 await page.getByRole('combobox',{name:'Session length'}).click();await page.getByRole('option',{name:'Every day'}).click();
 await page.getByRole('group',{name:'Allowed ways to sign in'}).getByLabel('Apple').uncheck();
 await page.getByRole('button',{name:'Save sign-in rules'}).click();
 // A stricter rule first says who it affects (here: nobody), then saves.
 const preview=await waitWrite(w=>w.ep==='/api/v1/settings/impact');assert.equal(preview.b.kind,'security');assert.equal(preview.b.minPasswordLength,12);
 const confirm=page.getByRole('dialog');await confirm.getByText('Nobody is affected',{exact:false}).waitFor();
 await confirm.getByRole('button',{name:'Save',exact:true}).click();
 const saved=await waitWrite(w=>w.ep==='/api/v1/workspace/security');
 assert.equal(saved.b.minPasswordLength,12);assert.equal(saved.b.sessionHours,24);assert.ok(!saved.b.allowedSignIn.includes('apple'));assert.ok(saved.b.allowedSignIn.includes('password'));
 checks.push('rules');

 // Members' security: filter to those without two-step, remind them in one click; nothing shows a password.
 const card=page.locator('.mss');
 assert.ok((await card.innerText()).includes('without two-step'));
 await card.getByRole('button',{name:/without two-step/}).click();
 assert.equal(await card.locator('tbody tr').count(),2);
 await card.getByRole('button',{name:'Remind 2 to turn on two-step'}).click();
 const reminded=await waitWrite(w=>w.ep==='/api/v1/workspace/security/remind');
 assert.deepEqual(reminded.b,{userIds:['u2','u3'],topic:'two-step'});
 await card.getByText('Reminded').first().waitFor();
 await shot(page,'members-1440.png');
 checks.push('members-remind');

 // Phone.
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
 await fitsPhone(page,'workspace security',assert);
 await page.goto(origin+'/preview-org/account/security');await page.getByRole('list',{name:'Sign-in history'}).waitFor();await page.waitForTimeout(300);
 await fitsPhone(page,'sign-in history',assert);
 checks.push('phone');

 assert.deepEqual(errors,[]);
 console.log('security ui ok:',checks.join(', '));
 await ctx.close();
}finally{await browser.close();}
