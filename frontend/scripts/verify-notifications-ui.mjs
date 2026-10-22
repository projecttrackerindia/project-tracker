import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';

// Notification Center inbox: two lanes (Needs you / Updates) and Archived, notices about the same thing bundled into one row, archive with
// undo, mute a kind with undo, "Why am I getting this", clear read, and the phone layout. Built frontend with synthetic API fixtures only;
// notification text must render as literal text.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/notifications-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const N=(id,type,title,mins,link,isRead,needsYou,body=null)=>({id,type,title,body,link,isRead,createdAt:iso(-mins),browser:false,needsYou,archived:false});
const needs=[
 N('n1','TaskAssigned','You were assigned "Fix portal login"',5,'/tasks/t1',false,true,'Payments Core · due Friday'),
 N('n2','Mention','Ravi mentioned you on "Fix portal login"',9,'/tasks/t1',false,true),
 N('n3','Approval','Approve leave for Meena <img src=x onerror="window.ncUnsafe=1">',30,'/approvals/a1',true,true),
];
const info=[N('n4','Comment','New comment on "Release notes"',40,'/tasks/t2',true,false,'Looks good to me')];
const archived=[{...N('n5','Comment','Old comment on "Budget"',3000,'/tasks/t3',true,false),archived:true}];
let prefs=[
 {type:'TaskAssigned',label:'Assigned to me',description:'When work is assigned to you',inApp:true,email:true,browser:true,locked:false},
 {type:'Security',label:'Security alerts',description:'Sign-ins and account changes',inApp:true,email:true,browser:true,locked:true},
];
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async()=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');});
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[];
   const p=url.searchParams;
   if(/^\/api\/v1\/notifications\/n\d\/(archive|unarchive|read)$/.test(ep)&&method==='POST'){writes.push({ep});await route.fulfill({status:204,body:''});return;}
   else if(ep==='/api/v1/notifications/archive-read'&&method==='POST'){writes.push({ep});data={archived:2};}
   else if(ep==='/api/v1/notifications/read-all'&&method==='POST'){writes.push({ep});data=null;}
   else if(ep==='/api/v1/me/notification-preferences'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});prefs=prefs.map(x=>{const c=b.items.find(i=>i.type===x.type);return c?{...x,...c}:x;});data=prefs;}
   else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
   else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','tasks.view','org.manage','reports.view','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
    else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
    else if(ep==='/api/v1/notifications/counts')data={unread:2,needsYou:2,forInfo:0};
    else if(ep==='/api/v1/notifications'){
     const list=p.get('archived')==='true'?archived:p.get('lane')==='info'?info:p.get('lane')==='needs'?needs:[...needs,...info];
     const it=p.get('unreadOnly')==='true'?list.filter(n=>!n.isRead):list;
     data={items:it,page:1,pageSize:20,totalPages:1,totalItems:it.length};
    }
    else if(ep==='/api/v1/me/notification-preferences')data=prefs;
    else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
    else if(ep==='/api/v1/timer')data=null;
    else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
    else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
    else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
    else if(ep==='/api/v1/chat/projects/unread')data=[];
    else if(ep.includes('/counts')||ep.includes('/unread'))data={count:2,total:0};
   }
   await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
  });
  return ctx;};
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(300);await page.screenshot({path:path.join(out,name)});};
 const waitWrite=async(test)=>{for(let i=0;i<40&&!writes.some(test);i++)await new Promise(r=>setTimeout(r,100));return writes.find(test);};
 const ctx=await make();const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 await page.goto(origin+'/preview-org/notifications');await page.locator('.nc-item').first().waitFor();

 // "Needs you" opens first with its count; the two notices about the same task are one row with "+1" behind it.
 const tab=(name)=>page.getByRole('tab',{name:new RegExp(`^${name}`)});
 assert.equal(await tab('Needs you').getAttribute('aria-selected'),'true');
 assert.match(await tab('Needs you').innerText(),/2/);
 assert.equal(await page.locator('.nc-item').count(),2,'n1 and n2 bundle into one row');
 assert.match(await page.locator('.nc-item').first().innerText(),/assigned "Fix portal login"/);
 await page.locator('.nc-more').first().click();
 assert.match(await page.locator('.nc-sub').innerText(),/Ravi mentioned you/);
 // The title is text, never markup.
 assert.match(await page.locator('.nc-item').nth(1).innerText(),/<img src=x/);
 assert.equal(await page.evaluate(()=>window.ncUnsafe),undefined);
 checks.push('lanes-and-bundles');
 await shot(page,'inbox-desktop.png');

 // Why am I getting this?
 const first=page.locator('.nc-item').first();
 await first.hover();await first.locator('.nc-menu > summary').click();
 await page.getByRole('menuitem',{name:'Why am I getting this?'}).click();
 assert.match(await page.locator('.nc-why').innerText(),/assignee/);
 checks.push('why');

 // Archive the bundle: both notices are archived; Undo brings both back.
 await first.hover();await first.getByRole('button',{name:'Archive'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n1/archive'));
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n2/archive'));
 await page.locator('.toast-action',{hasText:'Undo'}).first().click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n1/unarchive'));
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n2/unarchive'));
 checks.push('archive-undo');

 // Mute this kind: the app and push go off for "Assigned to me" (email stays); Undo restores it.
 await first.hover();await first.locator('.nc-menu > summary').click();
 await page.getByRole('menuitem',{name:'Mute this kind'}).click();
 const muted=await waitWrite(w=>w.ep==='/api/v1/me/notification-preferences');
 assert.deepEqual(muted.b.items,[{type:'TaskAssigned',inApp:false,email:true,browser:false}]);
 await page.locator('.toast-action',{hasText:'Undo'}).first().click();
 await waitWrite(w=>w.ep==='/api/v1/me/notification-preferences'&&w.b.items[0].inApp===true);
 assert.deepEqual(writes.filter(w=>w.ep==='/api/v1/me/notification-preferences').at(-1).b.items,[{type:'TaskAssigned',inApp:true,email:true,browser:true}]);
 checks.push('mute-undo');

 // Mark read on the bundle reads every unread notice in it.
 await first.hover();await first.getByRole('button',{name:'Mark as read'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n1/read'));
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n2/read'));
 checks.push('read-bundle');

 // Updates, then Clear read.
 await tab('Updates').click();
 await page.locator('.nc-item',{hasText:'Release notes'}).waitFor();
 assert.equal(await page.locator('.nc-item').count(),1);
 await page.getByRole('button',{name:'Clear read'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/archive-read'));
 checks.push('updates-clear-read');

 // Archived: move back to the inbox.
 await tab('Archived').click();
 await page.locator('.nc-item',{hasText:'Budget'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Clear read'}).count(),0);
 const old=page.locator('.nc-item').first();await old.hover();await old.getByRole('button',{name:'Move to inbox'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n5/unarchive'));
 checks.push('archived');

 // Phone.
 await tab('Needs you').click();await page.locator('.nc-item',{hasText:'Fix portal login'}).first().waitFor();
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
 await fitsPhone(page,'notification inbox',assert);
 // On a phone, reading and archiving are in the row's menu.
 const row=page.locator('.nc-item').first();
 assert.equal(await row.getByRole('button',{name:'Archive'}).isVisible(),false);
 await row.locator('.nc-menu > summary').click();
 assert.ok(await page.getByRole('menuitem',{name:'Archive'}).isVisible());
 await page.getByRole('menuitem',{name:'Archive'}).click();
 assert.ok(await waitWrite(w=>w.ep==='/api/v1/notifications/n1/archive'&&writes.filter(x=>x.ep===w.ep).length>1));
 await page.waitForTimeout(5500);   // toasts gone before the picture
 await shot(page,'inbox-phone.png');
 checks.push('phone');

 assert.deepEqual(errors,[]);
 console.log('notifications ui ok:',checks.join(', '));
 await ctx.close();
}finally{await browser.close();}
