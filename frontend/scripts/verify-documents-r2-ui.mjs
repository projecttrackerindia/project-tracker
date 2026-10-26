import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Documents release 2 on screen: a toggle and a live task list inside a page, "may be out of date" with what changed and "Still correct",
// AI on selected text (preview, then replace), a comment on selected text (its highlight saved in the page) and resolving a thread from
// its highlight, "/" for a toggle and a task list, a jump to a cited block, DocTracker's "Write with AI", ask-the-pages with citations,
// words found inside pages, drafts to approve, team spaces and dragging a page into another. Built frontend, synthetic API only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/documents-r2-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const pid='00000000-0000-0000-0000-000000000003', team='00000000-0000-0000-0000-0000000000aa';
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const project={id:pid,key:'PAY',name:'Payments Core',status:'Active',progress:40,taskCount:2,memberCount:3,ownerId:user.id,ownerName:user.displayName,startDate:null,dueDate:null,createdAt:iso(-9000)};
const t=(text,marks)=>({type:'text',text,...(marks?{marks}:{})});
const body=JSON.stringify({type:'doc',content:[
  {type:'heading',attrs:{level:2},content:[t('Refund flow')]},
  {type:'paragraph',content:[t('Customers get refunds in five working days after approval.')]},
  {type:'paragraph',content:[t('Escalate to '),t('the payments desk',[{type:'comment',attrs:{id:'c-old'}}]),t(' when it is late.')]},
  {type:'details',attrs:{open:false},content:[{type:'detailsSummary',content:[t('Bank cut-off times')]},{type:'detailsContent',content:[{type:'paragraph',content:[t('HDFC 4 pm, SBI 3 pm.')]}]}]},
  {type:'liveTasks',attrs:{projectId:pid,filter:'open',limit:10}},
  {type:'paragraph',content:[t('Last line of the page.')]},
]});
const item={id:'pg',key:'DOC-12',number:12,title:'Refund handbook',typeId:'t3',typeCode:'PAGE',typeName:'Page',typeColor:'#4f46e5',typeIcon:'note',projectId:pid,projectKey:'PAY',projectName:'Payments Core',
  teamId:null,teamName:null,owner:{id:user.id,name:user.displayName},status:'Draft',visibility:'Project',classification:'Internal',tags:[],updatedAt:iso(-30),createdAt:iso(-6000),linkedCount:1,versionLabel:'Draft',sharedCount:0,parentId:null,pageOrder:0,icon:'📗'};
let page1={item,revision:5,versionLabel:'Draft',publishedLabel:null,hasUnpublishedChanges:false,viewingPublished:false,can:{edit:true,delete:true,link:true,share:true,publish:true},
  maskedCount:0,revealed:false,revealSeconds:0,canReveal:false,sections:[{key:'body',title:'Page',kind:'RichText',sortOrder:0,content:body}]};
let fresh={stale:true,since:iso(-120),reasons:[{kind:'task',key:'PAY-7',title:'Refund export',detail:'now Done',at:iso(-120),link:'/tasks/t7'}],lastEditedAt:iso(-3000),verifiedAt:null,verifiedBy:null,canVerify:true,summary:'PAY-7 “Refund export” is now Done.'};
let comments=[{id:'k1',user:{id:'u2',name:'Ravi Kumar'},body:'Is the desk still the right team?',createdAt:iso(-50),editedAt:null,mine:false,parentId:null,anchorId:'c-old',quote:'the payments desk',resolvedAt:null,resolvedBy:null,canResolve:true}];
const task=(n,title,status,color,extra={})=>({id:`t${n}`,projectId:pid,projectKey:'PAY',projectName:'Payments Core',number:n,key:`PAY-${n}`,title,description:null,statusId:'s',statusName:status,statusCategory:'InProgress',statusColor:color,priority:'Medium',
  assignee:{id:user.id,name:'Asha Rao'},reporter:null,startDate:null,dueDate:'2026-11-02',estimatedHours:null,actualHours:null,position:0,parentTaskId:null,subtaskTotal:0,subtaskDone:0,commentCount:0,labels:[],completedAt:null,createdAt:iso(-900),updatedAt:iso(-60),version:1,isOverdue:false,
  milestoneId:null,milestoneName:null,dependsOnCount:0,blocksCount:0,isBlocked:false,sprintId:null,sprintName:null,checklistTotal:0,checklistDone:0,canEdit:true,stageId:null,stageName:null,...extra});
const tasks=[task(8,'Refund status on WhatsApp','In progress','#2563eb'),task(9,'Bank file reconciliation','To do','#64748b',{isOverdue:true})];
const pageDoc=(id,title,parentId,order,teamId=null,projectDoc=true)=>({id,key:`DOC-${id}`,title,typeCode:'PAGE',typeName:'Page',typeColor:'#4f46e5',status:'Draft',classification:'Internal',updatedAt:iso(-10),isApi:false,parentId,pageOrder:order,icon:null,teamId,_p:projectDoc});
const catalog={projects:[{id:pid,key:'PAY',name:'Payments Core',endpoints:[],definitions:[],diagrams:0,documents:[{...pageDoc('pg','Refund handbook',null,0),icon:'📗'},pageDoc('q1','Chargebacks',null,1),pageDoc('q2','Disputes',null,2)]},
  {id:null,key:null,name:'General',endpoints:[],definitions:[],diagrams:0,documents:[pageDoc('h1','Holidays',null,0),pageDoc('tm1','Desk handbook',null,0,team),pageDoc('tm2','Call scripts','tm1',0,team)]}],
  canCreate:true,isAdmin:true,truncated:0,teams:[{id:team,name:'Collections desk',mine:true,pages:2}]};
const draftBody=JSON.stringify({type:'doc',content:[{type:'heading',attrs:{level:2},content:[t('What changed')]},{type:'bulletList',content:[{type:'listItem',content:[{type:'paragraph',content:[t('PAY-8 Refund status on WhatsApp')]}]}]}]});
let proposals=[{id:'pr1',projectId:pid,projectKey:'PAY',kind:'release-notes',sourceType:'sprint',sourceId:'sp1',title:'Release notes – Sprint 14',summary:'5 tasks finished in Sprint 14',body:draftBody,targetDocumentId:null,targetTitle:null,status:'Proposed',createdAt:iso(-30),resultDocumentId:null,action:'create'},
  {id:'pr2',projectId:pid,projectKey:'PAY',kind:'decision-log',sourceType:'meeting',sourceId:'m1',title:'Decision log',summary:'2 decisions from “Refund review”',body:draftBody,targetDocumentId:'dl',targetTitle:'Decision log',status:'Proposed',createdAt:iso(-90),resultDocumentId:null,action:'add'}];
let made=null;
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async()=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');});
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.startsWith('/hubs/')){await route.fulfill({status:404,body:''});return;}   // no live connection: the page edits on its own
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[],status=200;
   const json=(d)=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:d})});
   const b=method==='GET'?null:(()=>{try{return req.postDataJSON();}catch{return null;}})();
   if(method!=='GET'&&!ep.endsWith('/auth/refresh')&&!ep.endsWith('/views'))writes.push({method,ep,b});
   if(ep==='/api/v1/documents/pg/sections'&&method==='PUT'){assert.equal(b.revision,page1.revision,'each save carries the newest revision');page1={...page1,revision:page1.revision+1,sections:[{...page1.sections[0],content:b.sections[0].content}]};await json(page1);return;}
   if(ep==='/api/v1/documents/pg/verify'){fresh={...fresh,stale:false,reasons:[],since:null,verifiedAt:iso(0),verifiedBy:'Asha Rao'};await json(fresh);return;}
   if(ep==='/api/v1/documents/ai/transform'){assert.equal(b.action,'shorten');assert.match(b.text,/five working days/);await json({text:'Refunds take five working days.',blocks:JSON.stringify([{type:'paragraph',content:[t('Refunds take five working days.')]}]),model:'test',inline:true});return;}
   if(ep==='/api/v1/documents/pg/comments'&&method==='POST'){const c={id:`k${comments.length+1}`,user:{id:user.id,name:user.displayName},body:b.body,createdAt:iso(0),editedAt:null,mine:true,parentId:b.parentId??null,anchorId:b.anchorId??null,quote:b.quote??null,resolvedAt:null,resolvedBy:null,canResolve:true};comments=[...comments,c];await json(c);return;}
   if(/^\/api\/v1\/documents\/pg\/comments\/k\d+\/resolve$/.test(ep)){const id=ep.split('/')[6];comments=comments.map((c)=>c.id===id?{...c,resolvedAt:b.resolved?iso(0):null,resolvedBy:b.resolved?'Asha Rao':null}:c);await json(comments.find((c)=>c.id===id));return;}
   if(ep==='/api/v1/documents/ai/draft'){await json({title:'Refund escalation guide',body:draftBody,markdown:'## What changed',sources:['Your request'],model:'test'});return;}
   if(ep==='/api/v1/documents/ai/ask'){assert.match(b.question,/refund/i);await json({answer:'Refunds take five working days after approval [1].',citations:[{n:1,documentId:'pg',key:'DOC-12',title:'Refund handbook',icon:'📗',block:1,snippet:'Customers get refunds in five working days after approval.'}],pagesRead:3,model:'test',found:true});return;}
   if(ep==='/api/v1/documents/proposals/pr1/accept'){proposals=proposals.filter((p)=>p.id!=='pr1');await json({documentId:'pnew',message:'Created “Release notes – Sprint 14”.'});return;}
   if(ep==='/api/v1/documents/proposals/pr2/dismiss'){proposals=proposals.filter((p)=>p.id!=='pr2');await route.fulfill({status:204,body:''});return;}
   if(/^\/api\/v1\/documents\/\w+\/place$/.test(ep)){await json(page1);return;}
   if(ep==='/api/v1/documents'&&method==='POST'){made={...page1,item:{...item,id:'pnew',title:b.title},revision:1,sections:[{...page1.sections[0],content:b.sections?.[0]?.content??''}]};await json(made);return;}
   if(method!=='GET'&&!ep.endsWith('/auth/refresh')&&!ep.endsWith('/views')&&ep!=='/api/v1/documents/pnew/sections')assert.fail(`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','docs.create','docs.edit','docs.delete','docs.workflow','org.manage'],modules:{projects:3,tasks:3,documents:3,calendar:3,work:3,ai:3,activity:3,people:3,reports:3,billing:3,audit:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/projects')data={items:[project],page:1,totalPages:1,totalItems:1};
   else if(ep===`/api/v1/projects/${pid}/tasks`){assert.equal(url.searchParams.get('openOnly'),'true','the list shows open tasks');data={items:tasks,page:1,totalPages:1,totalItems:2};}
   else if(ep==='/api/v1/doctracker/catalog')data=catalog;
   else if(ep==='/api/v1/documents/pg')data=page1;
   else if(ep==='/api/v1/documents/pnew')data=made;
   else if(ep==='/api/v1/documents/pg/freshness')data=fresh;
   else if(ep==='/api/v1/documents/pg/comments')data=comments;
   else if(ep==='/api/v1/documents/proposals')data=proposals;
   else if(ep==='/api/v1/documents/search')data={hits:url.searchParams.get('q')?.includes('cut-off')?[{id:'pg',key:'DOC-12',title:'Refund handbook',icon:'📗',projectId:pid,projectName:'Payments Core',line:'Bank cut-off times',block:3,score:4,updatedAt:iso(-30),typeCode:'PAGE'}]:[],total:1};
   else if(ep==='/api/v1/documents/dashboard')data={total:2,byStatus:[],byType:[],mine:2,waitingForMe:0,updatedThisWeek:1,notUpdatedIn90Days:0,unpublished:0,recent:[],projectsMissingRequired:0,requiredTypes:0};
   else if(ep==='/api/v1/document-types')data=[['PAGE','Page','#4f46e5','A free-form page'],['SOP','Standard operating procedure','#d97706','Step-by-step']].map(([code,name,color,description],i)=>({id:code==='PAGE'?'t3':'t'+i,code,name,color,description,icon:'note',sortOrder:i,
     sections:code==='PAGE'?[]:[{key:'steps',title:'Steps',kind:'RichText',hint:'',columns:null}]}));
   else if(ep.endsWith('/backlinks'))data=[];
   else if(/^\/api\/v1\/documents\/(pg|pnew)\//.test(ep))status=404;
   else if(ep==='/api/v1/workspace/members')data=[{userId:user.id,displayName:user.displayName,email:user.email,role:'Owner'}];
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep==='/api/v1/chat/projects/unread')data=[];
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
   if(status!==200){await route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:{code:'NOT_FOUND',message:'Not found'}})});return;}
   await json(data);
  });
  return ctx;};
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(350);await page.screenshot({path:path.join(out,name)});};
 const waitFor=async(fn,what)=>{for(let i=0;i<60;i++){if(fn())return;await new Promise(r=>setTimeout(r,100));}assert.fail(`timed out waiting for ${what}`);};
 const lastSave=()=>writes.filter(w=>w.ep==='/api/v1/documents/pg/sections').at(-1)?.b.sections[0].content??'';
 const select=async(page,locator,text)=>{
  // Selects exactly these words inside the editor (as a person dragging over them would).
  await locator.evaluate((el,words)=>{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode())){const i=n.textContent.indexOf(words);if(i>=0){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+words.length);const s=getSelection();s.removeAllRanges();s.addRange(r);return;}}throw new Error('words not found: '+words);},text);
  await page.waitForTimeout(150);
 };
 let ctx=await make();let page=await ctx.newPage();
 page.on('pageerror',e=>{errors.push(e.message);console.log('STACK',e.stack?.split('\n').slice(0,6).join(' | '));});
 await page.setViewportSize({width:1440,height:1000});

 // A page with a toggle, a highlighted passage and a live task list; it may be out of date.
 await page.goto(origin+'/preview-org/documents/pg');
 await page.locator('.pg-title').waitFor();
 const editor=page.locator('.pg-body .ProseMirror');
 await editor.locator('[data-type="details"]',{hasText:'Bank cut-off times'}).waitFor();
 assert.equal(await editor.getByText('HDFC 4 pm, SBI 3 pm.').isVisible(),false,'a closed toggle hides its content');
 await editor.locator('[data-type="details"] > button').first().click();
 await editor.getByText('HDFC 4 pm, SBI 3 pm.').waitFor();
 await editor.locator('.live-tasks .live-tasks-list li',{hasText:'Refund status on WhatsApp'}).waitFor();
 assert.equal(await editor.locator('.live-tasks .live-tasks-list li').count(),2);
 assert.match(await editor.locator('.live-tasks li',{hasText:'Bank file reconciliation'}).textContent(),/overdue/);
 checks.push('toggle','live-tasks');
 await page.locator('.pg-stale',{hasText:'This page may be out of date'}).waitFor();
 await page.getByRole('button',{name:'What changed'}).click();
 await page.locator('.pg-stale-list a',{hasText:'PAY-7 · Refund export'}).waitFor();
 await shot(page,'page-stale-1440.png');
 await page.getByRole('button',{name:'Still correct'}).click();
 await page.locator('.pg-verified',{hasText:'Verified'}).waitFor();
 assert.equal(await page.locator('.pg-stale').count(),0);
 assert.ok(writes.some(w=>w.ep==='/api/v1/documents/pg/verify'));checks.push('stale-verify');

 // AI on selected text: preview first, then replace; the page saves the new words.
 await select(page,editor,'Customers get refunds in five working days after approval.');
 await page.locator('.rte-bubble .rte-ai').click();
 await page.locator('.pg-ai-menu').getByRole('menuitem',{name:'Shorter'}).click();
 await page.locator('.ai-sel-out',{hasText:'Refunds take five working days.'}).waitFor();
 await shot(page,'ai-selection-1440.png');
 await page.locator('.ai-sel').getByRole('button',{name:'Replace'}).click();
 await waitFor(()=>lastSave().includes('Refunds take five working days.'),'the AI text to be saved');
 assert.ok(!lastSave().includes('Customers get refunds'),'the selection was replaced');
 assert.ok(lastSave().includes('"type":"liveTasks"')&&lastSave().includes('"type":"details"'),'the other blocks are kept');checks.push('ai-selection');

 // A comment on selected text: the thread opens beside the page, the highlight is saved in the page.
 await select(page,editor,'Last line');
 await page.locator('.rte-bubble').getByRole('button',{name:'Comment on this'}).click();
 const panel=page.locator('aside.ct');
 await panel.locator('.ct-new .ct-quote',{hasText:'Last line'}).waitFor();
 await panel.getByLabel('Your comment').fill('Add the SLA here.');
 await panel.locator('.ct-new').getByRole('button',{name:'Comment'}).click();
 await waitFor(()=>writes.some(w=>w.ep==='/api/v1/documents/pg/comments'&&w.b.body==='Add the SLA here.'),'the comment');
 const posted=writes.find(w=>w.ep==='/api/v1/documents/pg/comments'&&w.b.body==='Add the SLA here.').b;
 assert.match(posted.anchorId,/^c-[a-z0-9]+$/i);assert.equal(posted.quote,'Last line');
 await waitFor(()=>lastSave().includes(`"id":"${posted.anchorId}"`),'the highlight to be saved');
 await panel.locator('.ct-thread',{hasText:'Add the SLA here.'}).waitFor();
 await shot(page,'comment-thread-1440.png');
 await panel.getByRole('button',{name:'Close comments'}).click();checks.push('comment-on-text');

 // Clicking a highlight opens its thread; resolving it takes the highlight off.
 await editor.locator('.rte-comment[data-comment-id="c-old"]').click();
 await panel.locator('.ct-thread.focus',{hasText:'Is the desk still the right team?'}).waitFor();
 await panel.locator('.ct-thread.focus').getByRole('button',{name:'Resolve'}).click();
 await waitFor(()=>writes.some(w=>w.ep==='/api/v1/documents/pg/comments/k1/resolve'),'the resolve');
 await waitFor(()=>!lastSave().includes('c-old'),'the highlight to come off');
 await panel.getByRole('tab',{name:/Resolved/}).click();
 await panel.locator('.ct-thread.done',{hasText:'Is the desk still the right team?'}).waitFor();
 await panel.getByRole('button',{name:'Close comments'}).click();checks.push('resolve-thread');

 // "/" puts in a toggle and a live task list.
 await editor.locator('p',{hasText:'Last line of the page.'}).click();await page.waitForTimeout(150);
 
 await page.keyboard.press('End');await page.keyboard.press('Enter');
 await page.keyboard.type('/toggle');await page.locator('.sgm-item',{hasText:'Toggle'}).waitFor();await page.keyboard.press('Enter');
 await page.keyboard.type('Escalation contacts');
 await waitFor(()=>(lastSave().match(/"type":"details"/g)??[]).length===2,'a second toggle');
 await editor.locator('p',{hasText:'Last line of the page.'}).click();await page.waitForTimeout(150);await page.keyboard.press('End');await page.keyboard.press('Enter');
 await page.keyboard.type('/live');await page.locator('.sgm-item',{hasText:'Live task list'}).waitFor();
 assert.ok(await page.locator('.sgm-item',{hasText:'Write with AI'}).count()===0,'the menu filters as you type');
 await page.keyboard.press('Enter');
 await waitFor(()=>(lastSave().match(/"type":"liveTasks"/g)??[]).length===2,'a second task list');
 await editor.locator('.live-tasks').nth(1).locator('.live-tasks-list li').first().waitFor();checks.push('slash-blocks');
 await shot(page,'page-r2-1440.png');

 // A citation opens the page at its line.
 await page.goto(origin+'/preview-org/documents/pg#b-1');
 await page.locator('.pg-body .pg-flash-box').waitFor();
 // The highlight sits over the cited block (the second one).
 const [boxTop,blockTop]=await page.evaluate(()=>[document.querySelector('.pg-flash-box').getBoundingClientRect().top,document.querySelector('.pg-body .ProseMirror').children[1].getBoundingClientRect().top]);
 assert.ok(Math.abs(boxTop+3-blockTop)<4,`the highlight is on the cited block (${boxTop} vs ${blockTop})`);checks.push('block-jump');

 // Phone: the page and its comments fit.
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:/Comments/}).click();await panel.waitFor();
 // The phone layout opens the page again: it shows the newest text (the resolved highlight stays gone), not the text from the first load.
 assert.equal(await page.locator('.pg-body [data-comment-id="c-old"]').count(),0,'the page reopens with its newest text');
 await fitsPhone(page,'page with comments on a phone',assert);
 await shot(page,'page-comments-390.png');
 await panel.getByRole('button',{name:'Close comments'}).click();
 await page.setViewportSize({width:1440,height:1000});checks.push('phone-page');

 // DocTracker (v2: Library › Docs › ··· › API workspace, ?view=home): ask the pages, words inside pages, drafts to approve, write with AI, team spaces, drag a page into another.
 await page.goto(origin+'/preview-org/library/docs?view=home');
 const search=page.getByLabel('Search DocTracker or ask a question');
 await search.fill('How long do refunds take?');await search.press('Enter');
 const answer=page.locator('.dt-ask-card');
 await answer.locator('.dt-ask-text',{hasText:'five working days'}).waitFor();
 assert.equal(await answer.locator('a.dt-cite').getAttribute('href'),'/preview-org/documents/pg#b-1');
 await shot(page,'ask-1440.png');checks.push('ask-the-space');
 await search.fill('cut-off');
 await page.locator('.dt-text-hit',{hasText:'Bank cut-off times'}).waitFor();
 assert.equal(await page.locator('.dt-text-hit').getAttribute('href'),'/preview-org/documents/pg#b-3');
 assert.equal(await page.locator('.dt-text-hit mark').first().textContent(),'cut-off');
 await search.fill('');checks.push('inside-page-search');

 const drafts=page.locator('.dt-drafts');
 await drafts.locator('.dt-draft-list > li').nth(1).waitFor();
 await drafts.locator('li',{hasText:'Release notes – Sprint 14'}).getByRole('button',{name:'Read'}).click();
 await drafts.locator('.dt-draft-body',{hasText:'PAY-8 Refund status on WhatsApp'}).waitFor();
 await drafts.locator('li',{hasText:'Release notes – Sprint 14'}).getByRole('button',{name:'Create page'}).click();
 await waitFor(()=>writes.some(w=>w.ep==='/api/v1/documents/proposals/pr1/accept'),'the accept');
 await drafts.locator('li',{hasText:'Decision log'}).getByRole('button',{name:'Dismiss'}).click();
 await waitFor(()=>writes.some(w=>w.ep==='/api/v1/documents/proposals/pr2/dismiss'),'the dismiss');
 await drafts.locator('.dl-empty').waitFor();checks.push('drafts-to-review');

 await page.locator('.dl-starter.ai').click();
 const dlg=page.getByRole('dialog');
 await dlg.getByLabel('What should the page be?').fill('How the support team escalates a late refund');
 await dlg.getByRole('button',{name:/Write the page/}).click();
 await dlg.locator('.aid-preview',{hasText:'What changed'}).waitFor();
 await shot(page,'ai-draft-1440.png');
 await dlg.getByRole('button',{name:'Create the page'}).click();
 await waitFor(()=>writes.some(w=>w.ep==='/api/v1/documents'&&w.method==='POST'),'the new page');
 const createdPage=writes.find(w=>w.ep==='/api/v1/documents'&&w.method==='POST').b;
 assert.equal(createdPage.title,'Refund escalation guide');assert.equal(createdPage.typeId,'t3');assert.match(createdPage.sections[0].content,/What changed/);
 const draftReq=writes.find(w=>w.ep==='/api/v1/documents/ai/draft');assert.ok(draftReq,'the draft was asked for');
 await page.locator('.pg-title').waitFor();checks.push('write-with-ai');

 await page.goto(origin+'/preview-org/library/docs?view=home');
 const tree=page.locator('nav.dt-tree');
 await tree.locator('.ds-rail-heading',{hasText:'Team spaces'}).waitFor();
 await tree.getByRole('button',{name:'Open Collections desk'}).click();
 await tree.locator('.dt-page-row',{hasText:'Desk handbook'}).waitFor();
 assert.equal(await tree.getByRole('button',{name:'New page for Collections desk'}).count(),1);
 await tree.getByRole('button',{name:'Open General'}).click();
 const general=tree.locator('li.ds-node',{has:page.locator('.ds-rail-label',{hasText:/^General$/})});
 await general.locator('.ds-type-head',{hasText:'Documents'}).click();
 await general.locator('.dt-page-row',{hasText:'Holidays'}).waitFor();
 assert.equal(await general.locator('.dt-page-row',{hasText:'Desk handbook'}).count(),0,'team pages are in the team space, not the company pages');
 checks.push('team-spaces');
 await tree.getByRole('button',{name:'Open Payments Core'}).click();
 const pay=tree.locator('li.ds-node',{has:page.locator('.ds-rail-label',{hasText:/^Payments Core$/})});
 await pay.locator('.ds-type-head',{hasText:'Documents'}).click();
 const disputes=pay.locator('.dt-page-row',{hasText:'Disputes'}), handbook=pay.locator('.dt-page-row',{hasText:'Refund handbook'});
 await disputes.waitFor();
 await disputes.dragTo(handbook);
 await waitFor(()=>writes.some(w=>w.ep==='/api/v1/documents/q2/place'),'the move');
 assert.deepEqual(writes.find(w=>w.ep==='/api/v1/documents/q2/place').b,{parentId:'pg',pageOrder:0});
 await pay.locator('.dt-page-row',{hasText:'Chargebacks'}).locator('a').focus();await page.keyboard.press('Alt+ArrowUp');
 await waitFor(()=>writes.some(w=>w.ep==='/api/v1/documents/q1/place'),'the keyboard move');
 assert.deepEqual(writes.find(w=>w.ep==='/api/v1/documents/q1/place').b,{parentId:null,pageOrder:0});
 await shot(page,'tree-1440.png');checks.push('drag-reorder');

 await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/library/docs?view=home');await page.locator('.dt-drafts').waitFor();
 await fitsPhone(page,'DocTracker home on a phone',assert);
 await shot(page,'doctracker-390.png');checks.push('phone-home');
 // The page tree on a phone, in dark mode.
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
 await page.getByRole('button',{name:'Browse DocTracker'}).click();await page.waitForTimeout(400);
 await fitsPhone(page,'DocTracker tree on a phone (dark)',assert);
 await shot(page,'doctracker-tree-390-dark.png');checks.push('phone-tree-dark');
 // The page itself in dark mode, with its comments open.
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/documents/pg');await page.locator('.pg-title').waitFor();
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
 await page.locator('.pg-body .ProseMirror').waitFor();
 await shot(page,'page-dark-1440.png');checks.push('page-dark');
 await page.close();await ctx.close();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,errors}));
}finally{await browser.close();}
