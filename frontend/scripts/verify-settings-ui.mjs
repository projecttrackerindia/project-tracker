import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Settings as one place: the overview (search, setup health with fixes, the seven groups, latest changes with undo), search that jumps to
// the switch (from Settings and Ctrl+K), "last changed by" on a setting, the "who this affects" check before a risky switch or a shorter
// retention is saved, and the notification defaults for members. Synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/settings-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false,mfaEnabled:true};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4,timeZone:null};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const ago=(m)=>new Date(Date.now()-m*60000).toISOString();
const perms=['org.manage','access.manage','permissions.manage','members.invite','members.manage','audit.view','projectgroups.manage','workflow.manage','labels.manage','work.types.manage','projects.view','tasks.view'];
let dismissed=false;
const health=()=>({score:dismissed?71:58,done:dismissed?5:4,total:8,open:dismissed?3:4,checks:[
 {id:'two-step',title:'Two-step sign-in is not required',detail:'2 of 4 members sign in with a password alone. A stolen password is then enough to get in.',severity:'high',ok:false,dismissed:false,dismissReason:null,fix:{label:'Require two-step',to:'/settings/security#s-security.requireMfa'},action:'remind-two-step',actionLabel:'Remind 2 members',canDismiss:true},
 {id:'backup-admin',title:'No backup admin',detail:'Only Asha Rao can manage settings, members and billing. If they are away or leave, nobody can.',severity:'high',ok:false,dismissed:false,dismissReason:null,fix:{label:'Make someone an admin',to:'/settings/members'},action:null,actionLabel:null,canDismiss:true},
 {id:'webhook-signing',title:'Webhooks without signing',detail:'1 incoming address accepts requests without a secret or signature, so anyone who learns the address can create work.',severity:'medium',ok:false,dismissed:false,dismissReason:null,fix:{label:'Add a secret',to:'/settings/webhooks'},action:null,actionLabel:null,canDismiss:true},
 {id:'whatsapp',title:'WhatsApp is not connected',detail:'Connect your business number so customers reach the support desk on WhatsApp.',severity:'medium',ok:false,dismissed,dismissReason:dismissed?'We do not use WhatsApp':null,fix:{label:'Connect WhatsApp',to:'/settings/whatsapp'},action:null,actionLabel:null,canDismiss:true},
 {id:'audit-chain',title:'The audit trail is intact',detail:'It is checked every night.',severity:'high',ok:true,dismissed:false,dismissReason:null,fix:null,action:null,actionLabel:null,canDismiss:false},
 {id:'time-zone',title:'No workspace time zone',detail:'Set yours so digests run on your working hours.',severity:'low',ok:false,dismissed:false,dismissReason:null,fix:{label:'Set the time zone',to:'/settings/general#s-workspace.timeZone'},action:null,actionLabel:null,canDismiss:true},
].filter((c)=>!(c.id==='whatsapp'&&false))});
const change=(key,section,setting,summary,mins,extra={})=>({key,section,setting,summary,action:'x',at:ago(mins),byId:'u2',byName:'Ravi Kumar',auditId:`a-${key}`,canUndo:true,undoTo:'Off',undoBlocked:null,wasUndo:false,...extra});
const changes={
 security:[change('security.requireMfa','security','Require two-step sign-in','Off → On',120)],
 general:[change('workspace.name','general','Workspace name','“Preview” → “Preview Workspace”',300,{undoTo:'“Preview”'})],
 data:[], notifications:[],
};
const recent=[changes.security[0],changes.general[0],change('integrations.apiKeys','api-keys','API keys','Added: CI deploy',600,{canUndo:false,undoTo:null})];
const ndKinds=[
 {type:'TaskAssigned',label:'Task assigned to me',description:'Someone assigns a task to you.',locked:false,needsYou:true,platform:{inApp:true,email:true,browser:true},workspace:{inApp:true,email:true,browser:true},changed:false,following:4,choseOwn:0},
 {type:'TaskUpdated',label:'Task updates',description:'A task you are assigned to changes.',locked:false,needsYou:false,platform:{inApp:true,email:true,browser:false},workspace:{inApp:true,email:true,browser:false},changed:false,following:3,choseOwn:1},
 {type:'Security',label:'Security alerts',description:'Always on.',locked:true,needsYou:true,platform:{inApp:true,email:true,browser:false},workspace:{inApp:true,email:true,browser:false},changed:false,following:4,choseOwn:0},
];
const nd={kinds:ndKinds,quietCustom:false,quietStart:null,quietEnd:null,digestCustom:false,digestTime:null,members:4,membersWithOwnSchedule:1,platformQuiet:'21:00–08:00',canEdit:true,updatedAt:null};
const security={requireMfa:false,ipAllowlistEnabled:false,ipRanges:[],myIp:'203.0.113.9',entitled:true,minPasswordLength:0,sessionHours:0,allowedSignIn:['password','passkey','google','microsoft','github','apple','sso'],platformMinPasswordLength:8};
const impactSecurity={kind:'security',headline:'2 of 4 members would be affected.',people:2,records:[],includesYou:false,warning:null,enforced:true,changes:['Two-step sign-in becomes required.'],
 affected:[{userId:'u3',name:'Kiran Das',email:'kiran@example.test',role:'Member',reasons:['Has no two-step sign-in: is asked to set it up before entering.']},{userId:'u4',name:'Meena Iyer',email:'meena@example.test',role:'Manager',reasons:['Has no two-step sign-in: is asked to set it up before entering.']}]};
const impactRetention={kind:'retention',headline:'1,204 records would be deleted permanently at the next nightly clean-up.',people:0,affected:[],includesYou:false,warning:'Deleted records cannot be brought back. Export first if you may need them.',enforced:true,
 changes:['Activity entries older than 30 days (kept forever until now).'],records:[{label:'Activity entries',count:1204,before:ago(43200)}]};
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin){await route.abort();return;}
  if(ep.endsWith('/avatar')||ep.endsWith('/logo/file')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  let data=[];
  const body=()=>{try{return req.postDataJSON();}catch{return null;}};
  if(method!=='GET'&&!ep.endsWith('/auth/refresh')&&ep!=='/api/v1/me/ui/sidebar'){
   writes.push({ep,method,b:body()});
   if(ep==='/api/v1/settings/health/whatsapp/dismiss'){dismissed=true;data=health();}
   else if(ep==='/api/v1/settings/health/two-step/remind')data={sent:2};
   else if(ep.startsWith('/api/v1/settings/changes/')&&ep.endsWith('/undo'))data={key:body().key,message:'Undone: Require two-step sign-in is back to Off.',latest:null};
   else if(ep==='/api/v1/settings/impact')data=body().kind==='retention'?impactRetention:impactSecurity;
   else if(ep==='/api/v1/workspace/security')data={...security,...body()};
   else if(ep==='/api/v1/workspace/data-policy')data={activityRetentionDays:30,notificationRetentionDays:null,chatRetentionDays:null,auditRetentionDays:null,planActivityDays:365,lastPurgedAt:null,canManage:true};
   else if(ep==='/api/v1/settings/notification-defaults')data=nd;
   else assert.fail(`Unexpected write: ${method} ${ep}`);
  }
  else if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
  else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
  else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:perms,modules:{projects:3,tasks:3,work:3,ai:3,activity:3,documents:3,members:3,organization:3,teams:3,audit:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
  else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
  else if(ep==='/api/v1/settings/health')data=health();
  else if(ep==='/api/v1/settings/changes')data={items:changes[url.searchParams.get('section')]??[],canUndo:true};
  else if(ep==='/api/v1/settings/changes/recent')data={items:recent,canUndo:true};
  else if(ep==='/api/v1/settings/notification-defaults')data=nd;
  else if(ep==='/api/v1/workspace/security')data=security;
  else if(ep==='/api/v1/workspace/security/members')data={members:4,withoutTwoStep:2,weakPasswords:0,oldPasswords:0,people:[]};
  else if(ep==='/api/v1/workspace/data-policy')data={activityRetentionDays:null,notificationRetentionDays:null,chatRetentionDays:null,auditRetentionDays:null,planActivityDays:365,lastPurgedAt:null,canManage:true};
  else if(ep==='/api/v1/workspace/logo')data={hasLogo:false};
  else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
  else if(ep==='/api/v1/notifications/counts')data={unread:0,needsYou:0,forInfo:0,snoozed:0};
  else if(ep==='/api/v1/notifications')data={items:[],page:1,pageSize:20,totalPages:0,totalItems:0};
  else if(ep==='/api/v1/timer')data=null;
  else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
  else if(ep==='/api/v1/chat/projects/unread')data=[];
  else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
  else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(300);await page.screenshot({path:path.join(out,name)});};
 const waitWrite=async(test)=>{for(let i=0;i<40&&!writes.some(test);i++)await new Promise(r=>setTimeout(r,100));return writes.find(test);};
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 try{
 // v2 Settings: You and Workspace, ten sections; General carries setup health with its fixes and the latest changes.
 await page.goto(origin+'/preview-org/settings/general');
 const nav=page.getByRole('navigation',{name:'Settings sections'});await nav.waitFor();
 for(const l of ['Profile','Workspace','People & roles','Notifications','Mail accounts','Security','Integrations','AI','Billing','Appearance'])assert.ok(await nav.getByRole('link',{name:l,exact:true}).isVisible(),`section ${l}`);
 const healthCard=page.getByRole('region',{name:'Setup health'});await healthCard.getByText('Two-step sign-in is not required').waitFor();
 assert.ok(await healthCard.getByRole('img',{name:'Setup health 58 out of 100'}).isVisible());
 await healthCard.getByRole('button',{name:'Remind 2 members'}).click();
 await waitWrite(w=>w.ep==='/api/v1/settings/health/two-step/remind');
 await page.getByText('Reminder sent to 2 member(s).').waitFor();
 await healthCard.locator('[data-check="whatsapp"]').getByRole('button',{name:'Not needed'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/settings/health/whatsapp/dismiss'));
 await healthCard.getByRole('button',{name:/Show 2 done or not needed/}).click();
 await healthCard.getByText('Marked as not needed here: We do not use WhatsApp.').waitFor();
 const latest=page.getByRole('region',{name:'Latest changes'});await latest.getByText('Ravi Kumar',{exact:false}).first().waitFor();
 assert.ok(await latest.getByText('Off → On').isVisible());
 await latest.getByRole('listitem').filter({hasText:'Require two-step sign-in'}).getByRole('button',{name:/Undo/}).click();
 const undo=await waitWrite(w=>w.ep.endsWith('/undo'));assert.equal(undo.b.key,'security.requireMfa');assert.match(undo.ep,/a-security\.requireMfa/);
 await page.getByText('Undone: Require two-step sign-in is back to Off.').waitFor();
 await shot(page,'general.png');
 checks.push('general-health-and-changes');

 // Search: "MFA" finds the two-step switch and jumps to it; the row says who changed it last.
 const search=page.getByRole('combobox',{name:'Find a setting'}).last();
 await search.fill('MFA');
 const first=page.getByRole('listbox',{name:'Settings found'}).getByRole('option').first();
 await first.getByText('Require two-step sign-in').waitFor();
 await search.press('Enter');
 await page.waitForURL(/\/settings\/security#s-security\.requireMfa$/);
 const row=page.locator('[data-setting="security.requireMfa"]');await row.waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-setting="security.requireMfa"]')?.classList.contains('setting-flash'));
 assert.match(await row.getByTestId('last-changed-security.requireMfa').innerText(),/by Ravi Kumar: Off → On/);
 for(const [q,label] of [['logo','Logo'],['retention','Keep activity for'],['slack','Slack']]){
  const s=page.getByRole('combobox',{name:'Find a setting'});await s.fill(q);
  await page.getByRole('listbox',{name:'Settings found'}).getByRole('option').first().getByText(label,{exact:true}).waitFor();
 }
 await page.getByRole('combobox',{name:'Find a setting'}).fill('');
 checks.push('search');

 // Safe change: requiring two-step shows who it affects; going back saves nothing; saving anyway does.
 await row.getByRole('checkbox').check();
 await page.getByRole('button',{name:'Save sign-in rules'}).click();
 const modal=page.getByRole('dialog');await modal.getByText('2 of 4 members would be affected.').waitFor();
 assert.ok(await modal.getByText('Kiran Das').isVisible());
 assert.ok(await modal.getByText('Two-step sign-in becomes required.').isVisible());
 await shot(page,'impact.png');
 await modal.getByRole('button',{name:'Go back'}).click();
 assert.ok(!writes.some(w=>w.ep==='/api/v1/workspace/security'));
 await page.getByRole('button',{name:'Save sign-in rules'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Save anyway (2 affected)'}).click();
 const put=await waitWrite(w=>w.ep==='/api/v1/workspace/security');assert.equal(put.b.requireMfa,true);
 checks.push('safe-change');

 // A shorter retention says how much would be deleted for good.
 await page.goto(origin+'/preview-org/settings/data#s-data.activity');
 await page.getByLabel('Activity history days').fill('30');
 await page.getByRole('button',{name:'Save retention'}).click();
 const rmodal=page.getByRole('dialog');await rmodal.getByText('1,204 records would be deleted permanently',{exact:false}).waitFor();
 await rmodal.getByRole('button',{name:'Save and delete when due'}).click();
 const dp=await waitWrite(w=>w.ep==='/api/v1/workspace/data-policy');assert.equal(dp.b.activityRetentionDays,30);
 checks.push('retention');

 // Notification defaults for members.
 await page.goto(origin+'/preview-org/settings/notifications/notifications');
 await page.getByRole('heading',{name:'Defaults for members'}).waitFor();
 await page.getByLabel('Task updates: E-mail').uncheck();
 assert.ok(await page.getByLabel('Security alerts: E-mail').isDisabled());
 await page.getByRole('radio',{name:/Our own/}).check();
 await page.getByLabel('Quiet from').fill('22:00');await page.getByLabel('Quiet until').fill('07:00');
 await page.getByRole('radio',{name:/Once a day at/}).check();
 await page.getByRole('button',{name:'Save defaults'}).click();
 const saved=await waitWrite(w=>w.ep==='/api/v1/settings/notification-defaults');
 const tu=saved.b.kinds.find(k=>k.type==='TaskUpdated');assert.equal(tu.email,false);assert.equal(saved.b.kinds.some(k=>k.type==='Security'),false);
 assert.equal(saved.b.quietCustom,true);assert.equal(saved.b.quietStart,'22:00');assert.equal(saved.b.quietEnd,'07:00');assert.equal(saved.b.digestCustom,true);assert.equal(saved.b.digestTime,'18:00');
 await shot(page,'notification-defaults.png');
 checks.push('notification-defaults');

 // Ctrl+K knows every setting too.
 await page.keyboard.press('Control+k');await page.keyboard.press('Control+k');   // v2: the first puts the cursor in the Ask bar, the second opens the palette
 const palette=page.getByRole('dialog',{name:'Command palette'});await palette.waitFor();
 await palette.getByRole('combobox').or(palette.getByLabel('Command')).first().fill('logo');
 await palette.getByRole('option').filter({hasText:/^Logo/}).first().waitFor();
 await palette.getByLabel('Command').press('Enter');
 await page.waitForURL(/\/settings\/general#s-workspace\.logo$/);
 await page.locator('[data-setting="workspace.logo"]').waitFor();
 checks.push('ctrl-k');

 // Phone: General (with setup health) fits.
 await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/settings/general');
 await page.getByRole('region',{name:'Setup health'}).waitFor();
 await fitsPhone(page,'settings general',assert);
 await shot(page,'phone.png');
 checks.push('phone');
 assert.deepEqual(errors,[]);
 console.log(`settings ui ok: ${checks.join(', ')}`);
 }catch(e){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw e;}
}finally{await browser.close();}
