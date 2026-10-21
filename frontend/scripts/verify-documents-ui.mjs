import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Documents, DocTracker-style: the tree (project ▸ type ▸ document ▸ sections) on the library and on a document, search across titles,
// collapse and resize, and the phone drawer. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/documents-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const pid='00000000-0000-0000-0000-000000000003';
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const project={id:pid,key:'PAY',name:'Payments Core',status:'Active',progress:40,taskCount:0,memberCount:3,ownerId:user.id,ownerName:user.displayName,startDate:null,dueDate:null,createdAt:iso(-9000)};
const D=(n,title,code,name,color,status,cls='Internal')=>({id:`d${n}`,key:`DOC-${n}`,number:n,title,typeId:`t-${code}`,typeCode:code,typeName:name,typeColor:color,typeIcon:'note',
  projectId:pid,projectKey:'PAY',projectName:'Payments Core',teamId:null,teamName:null,owner:{id:user.id,name:user.displayName},status,visibility:'Project',classification:cls,tags:[],
  updatedAt:iso(-60*n),createdAt:iso(-6000),linkedCount:0,versionLabel:'v1.0',sharedCount:0});
const docs=[D(1,'UPI collect API','API','API documentation','#35c491','Published'),D(2,'Loan balance API','API','API documentation','#35c491','Draft','Confidential'),D(3,'Payments BRD','BRD','Business requirements','#5c7cfa','InReview')];
const rich=(t)=>JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:t}]}]});
const detail={item:docs[0],revision:3,versionLabel:'v1.0',publishedLabel:'v1.0',hasUnpublishedChanges:false,viewingPublished:false,
  can:{edit:true,delete:true,link:true,share:true,publish:true},
  sections:[{key:'overview',title:'Overview',kind:'RichText',sortOrder:0,content:rich('Collect UPI payments from customers.')},{key:'auth',title:'Authentication',kind:'RichText',sortOrder:1,content:rich('client_id and client_secret headers.')},{key:'errors',title:'Error codes',kind:'RichText',sortOrder:2,content:rich('400, 401, 500.')}]};
const errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async()=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');});
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh')||ep.endsWith('/views'),`Unexpected write: ${method} ${ep}`);
   let data=[],status=200;
   if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','docs.create','docs.edit','docs.delete','docs.workflow','org.manage'],modules:{projects:3,tasks:3,documents:3,calendar:3,work:3,ai:3,activity:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/projects')data={items:[project],page:1,totalPages:1,totalItems:1};
   else if(ep==='/api/v1/documents'){const q=(url.searchParams.get('q')||'').toLowerCase(),p=url.searchParams.get('projectId');let it=docs.filter(d=>(!p||d.projectId===p)&&(!q||d.title.toLowerCase().includes(q)));if(url.searchParams.get('general')==='true')it=[];data={items:it,nextCursor:null,total:it.length};}
   else if(ep==='/api/v1/documents/inbox')data={toReview:[],submitted:[],accessToDecide:[],myAccessRequests:[],waiting:1};
   else if(ep==='/api/v1/documents/dashboard')data={total:3,byStatus:[{key:'Published',label:'Published',count:1},{key:'Draft',label:'Draft',count:1},{key:'InReview',label:'In review',count:1}],byType:[{key:'API',label:'API documentation',count:2},{key:'BRD',label:'Business requirements',count:1}],mine:3,waitingForMe:1,updatedThisWeek:2,notUpdatedIn90Days:0,unpublished:1,recent:docs,projectsMissingRequired:0,requiredTypes:0};
   else if(ep==='/api/v1/documents/d1')data=detail;
   else if(ep==='/api/v1/document-types')data=[];
   else if(ep.startsWith('/api/v1/documents/d1/'))status=404;
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep==='/api/v1/workspace/members')data=[{userId:user.id,displayName:user.displayName,role:'Owner'}];
   else if(ep==='/api/v1/chat/projects/unread')data=[];
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
   if(status!==200){await route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:{code:'NOT_FOUND',message:'Not found'}})});return;}
   await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
  });
  return ctx;};
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);await page.screenshot({path:path.join(out,name)});};
 let ctx=await make();let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});

 // Library: open the project in the tree, see documents grouped by type.
 await page.goto(origin+'/preview-org/documents');await page.locator('.ds-tree').waitFor();
 await page.getByRole('button',{name:'Open Payments Core'}).click();
 await page.locator('.ds-type-head',{hasText:'API documentation'}).waitFor();
 assert.equal(await page.locator('.ds-type',{hasText:'API documentation'}).locator('.ds-doc').count(),2);
 assert.equal(await page.locator('.ds-type',{hasText:'Business requirements'}).locator('.ds-doc').count(),1);
 await shot(page,'library-tree-1440.png');checks.push('tree-groups');

 // Search across titles.
 await page.getByLabel('Search documents and projects').fill('loan');
 await page.locator('.ds-doc',{hasText:'Loan balance API'}).waitFor();assert.equal(await page.locator('.ds-tree-docs .ds-doc').count(),1);
 await page.getByLabel('Search documents and projects').fill('');checks.push('search');

 // A document: the tree stays, its project opens on it and its sections are listed.
 await page.locator('.ds-doc-row',{hasText:'UPI collect API'}).click();
 await page.waitForURL(/\/documents\/d1/);await page.locator('.dv-head h1',{hasText:'UPI collect API'}).waitFor();
 await page.locator('.ds-doc.active .ds-sections a',{hasText:'Authentication'}).waitFor();
 assert.equal(await page.locator('.ds-doc.active .ds-sections a').count(),3);
 await shot(page,'document-tree-1440.png');checks.push('document-sections');

 // Collapse with the keyboard and the button, then back.
 await page.keyboard.press('Control+\\');await page.locator('.ds-shell.collapsed').waitFor();await shot(page,'document-collapsed-1440.png');
 await page.getByRole('button',{name:'Show document tree'}).click();await page.locator('.ds-shell:not(.collapsed)').waitFor();checks.push('collapse');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.close();await ctx.close();

 // Phone: the tree is a drawer.
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/documents/d1');await page.locator('.dv-head h1').waitFor();
 assert.equal(await page.locator('.ds-shell-side').isVisible(),false);
 await page.getByRole('button',{name:'Browse documents'}).click();await page.locator('.ds-drawer .ds-doc.active').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await shot(page,'document-drawer-390.png');checks.push('phone-drawer');
 await page.close();await ctx.close();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,errors}));
}finally{await browser.close();}
