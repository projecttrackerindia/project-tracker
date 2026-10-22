import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';

// The sidebar: hubs instead of duplicate places, sections that fold, drag to reorder (mouse and keyboard), Customize (pin, hide, reset),
// saved to the account; the Agents hub bar; pins on the phone's tab bar. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/sidebar-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const writes=[],errors=[],checks=[];
let saved=null;   // the account's copy of the layout
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async()=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  // These checks are about the classic layout (the Assistant entry); the AI-first Home, the default, is checked in verify-command-ui.
  await ctx.addInitScript(()=>{if(!localStorage.getItem('pm_home_mode'))localStorage.setItem('pm_home_mode','classic');});
  await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');});
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[];
   if(ep==='/api/v1/me/ui/sidebar'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});saved=b.value;data={key:'sidebar',value:saved,updatedAt:null};}
   else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:saved,updatedAt:null};
   else if(ep==='/api/v1/agent/inbox')data={items:[],pending:3,canDecide:true};
   else if(ep==='/api/v1/agent/assigned')data={items:[],pending:0,canDecide:false};
   else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','tasks.view','tasks.edit','org.manage','reports.view','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
    else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
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
 const labels=async(page)=>page.locator('.sidebar .nav-item span').allTextContents();
 const titles=async(page)=>page.locator('.sidebar .nav-section-toggle span').allTextContents();
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);await page.screenshot({path:path.join(out,name)});};

 let ctx=await make();
 let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 await page.goto(origin+'/preview-org/project-agent');await page.locator('.agh').waitFor();
 // Hubs: one Agents place; My work, Project agent and Agent Tracker are not listed twice.
 const first=await labels(page);
 assert.ok(first.includes('Assistant'));assert.ok(first.includes('Home'));
 for(const gone of ['My work','Project agent','Agent Tracker'])assert.ok(!first.includes(gone),`${gone} is inside a hub`);
 assert.ok(await page.locator('.sidebar .nav-item.active',{hasText:'Assistant'}).isVisible(),'Assistant is the open place on a proposals page');
 assert.deepEqual(await titles(page),['Home','Work','Insights']);
 const hub=await page.locator('.agh-tabs a').allInnerTexts();
 assert.ok(hub.some(t=>t.startsWith('Proposals'))&&hub.some(t=>t.startsWith('Tracker'))&&hub.some(t=>t.startsWith('Workflows')));
 assert.ok(await page.locator('.agh-tabs a.tab.active',{hasText:'Proposals'}).isVisible());checks.push('hubs');
 await shot(page,'hub-1440.png');
 // The light / dark switch, both ways.
 const sw=page.locator('.topbar .theme-switch');await sw.waitFor();
 await page.waitForTimeout(300);await sw.screenshot({path:path.join(out,'theme-light.png')});
 await sw.click();await page.waitForTimeout(1200);await sw.screenshot({path:path.join(out,'theme-dark.png')});
 assert.equal(await sw.getAttribute('aria-checked'),'true');
 await page.locator('.topbar').screenshot({path:path.join(out,'topbar-dark.png')});
 await sw.click();await page.waitForTimeout(1200);checks.push('theme-switch');

 // Fold a section by its title; it stays folded after a reload (account copy).
 await page.locator('.nav-section-toggle',{hasText:'Insights'}).click();await page.waitForTimeout(700);
 assert.ok(!(await labels(page)).includes('Reports'));
 assert.deepEqual(saved.collapsed,['Insights']);checks.push('fold');

 // Drag with the mouse: Calendar above Command Center.
 const grip=page.locator('[data-nav="/calendar"] .nav-grip');const target=page.locator('[data-nav="/command-center"]');
 await page.locator('[data-nav="/calendar"]').hover();
 const g=await grip.boundingBox(),t=await target.boundingBox();
 await page.mouse.move(g.x+g.width/2,g.y+g.height/2);await page.mouse.down();
 await page.mouse.move(g.x+g.width/2,g.y-10,{steps:4});await page.mouse.move(g.x+g.width/2,t.y+4,{steps:12});await page.waitForTimeout(150);
 await shot(page,'dragging-1440.png');
 await page.mouse.up();await page.waitForTimeout(800);
 const home=(await labels(page)).slice(0,6);
 assert.ok(home.indexOf('Calendar')<home.indexOf('Home'),`dragged: ${home}`);
 assert.ok(saved.order.Home.indexOf('/calendar')<saved.order.Home.indexOf('/command-center'));checks.push('drag-mouse');

 // And with the keyboard: Space, Arrow down, Space.
 await page.locator('[data-nav="/projects"] .nav-grip').focus();await page.keyboard.press('Space');await page.waitForTimeout(150);
 await page.keyboard.press('ArrowDown');await page.waitForTimeout(150);await page.keyboard.press('Space');await page.waitForTimeout(800);
 assert.equal(saved.order.Work[0],'/operations');checks.push('drag-keyboard');

 // Customize: pin Timesheet to the top, hide Activity, then Done.
 await page.getByRole('button',{name:'Customize'}).click();
 await page.getByRole('button',{name:'Pin Timesheet'}).click();
 await page.getByRole('button',{name:'Hide DocTracker'}).click();   // Activity is already hidden in the lean defaultawait page.waitForTimeout(300);
 await shot(page,'customize-1440.png');
 await page.getByRole('button',{name:'Done'}).click();await page.waitForTimeout(800);
 assert.equal((await titles(page))[0],'Pinned');assert.equal((await labels(page))[0],'Timesheet');
 assert.ok(!(await labels(page)).includes('DocTracker'));assert.ok(!(await labels(page)).includes('Activity'));
 assert.deepEqual(saved.pinned,['/timesheet']);assert.ok(saved.hidden.includes('/doctracker')&&saved.hidden.includes('/activity'));checks.push('pin-hide');
 await shot(page,'customized-1440.png');

 // The layout is the account's: a new page (another device) gets it.
 await page.close();await ctx.close();
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 await page.goto(origin+'/preview-org/project-agent');await page.locator('.agh').waitFor();await page.waitForTimeout(600);
 assert.equal((await labels(page))[0],'Timesheet');checks.push('follows-account');

 // Reset goes back to the standard layout (and clears the account copy).
 await page.getByRole('button',{name:'Customize'}).click();await page.getByRole('button',{name:'Reset'}).click();await page.waitForTimeout(800);
 assert.equal(saved,null);assert.deepEqual(await titles(page),['Home','Work','Insights']);checks.push('reset');
 await page.getByRole('button',{name:'Done'}).click();

 // Phone: a pin is offered in the tab bar.
 await page.getByRole('button',{name:'Customize'}).click();await page.getByRole('button',{name:'Pin Operations'}).click();await page.getByRole('button',{name:'Done'}).click();await page.waitForTimeout(800);
 await page.close();await ctx.close();
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/project-agent');await page.locator('.m-tabs').waitFor();await page.waitForTimeout(600);
 assert.ok(await page.locator('.m-tabs .m-tab[aria-label="Operations"]').count()===1,'the pinned place is a tab');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(await cutOff(page),[],'cut off at the right edge');
 await shot(page,'phone-390.png');checks.push('phone-pins');
 await page.close();await ctx.close();
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,writes:writes.length,errors},null,2));
 console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
