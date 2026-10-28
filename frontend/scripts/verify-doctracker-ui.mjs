import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Library documentation (what DocTracker did, rebuilt): old addresses redirect; the hub (collections with health, search, Start
// something), a project's documentation (topic navigator, reading column, "On this page"), an API symbol page (declaration, environment,
// parameters, cURL/JSON tabs, Try it, masked values with an audited reveal, raw JSON, editing on real values), architecture saving per
// project, Swagger (read only), Security Center, a document read inside its project with review, versions and the floating edit toolbar,
// pages, and phones. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/doctracker-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const pid='00000000-0000-0000-0000-000000000003';
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const project={id:pid,key:'PAY',name:'Payments Core',status:'Active',progress:40,taskCount:0,memberCount:3,ownerId:user.id,ownerName:user.displayName,startDate:null,dueDate:null,createdAt:iso(-9000)};
const D=(n,title,code,name,color,status,cls='Internal')=>({id:`d${n}`,key:`DOC-${n}`,number:n,title,typeId:`t-${code}`,typeCode:code,typeName:name,typeColor:color,typeIcon:'note',
  projectId:pid,projectKey:'PAY',projectName:'Payments Core',teamId:null,teamName:null,owner:{id:user.id,name:user.displayName},status,visibility:'Project',classification:cls,tags:[],
  updatedAt:iso(-60*n),createdAt:iso(-6000),linkedCount:0,versionLabel:'v1.0',sharedCount:0});
const docs=[D(1,'Payments APIs','API','API documentation','#35c491','Published'),D(3,'Payments BRD','BRD','Business requirements','#5c7cfa','InReview','Confidential')];
const rich=(t)=>JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:t}]}]});
const detail={item:docs[1],revision:3,versionLabel:'v1.0',publishedLabel:'v1.0',hasUnpublishedChanges:false,viewingPublished:false,
  can:{edit:true,delete:true,link:true,share:true,publish:true},maskedCount:1,revealed:false,revealSeconds:0,canReveal:true,
  sections:[{key:'overview',title:'Overview',kind:'RichText',sortOrder:0,content:rich('Escalations: ••••••3210.')},{key:'scope',title:'Scope',kind:'RichText',sortOrder:1,content:rich('UPI and cards.')}]};
const def={id:'def1',name:'Payments API',description:null,basePath:'/v1',version:'v1',auth:'Bearer',authNote:null,servers:['https://api.example.test'],endpoints:3,sortOrder:0,stage:'Uat'};
const E=(id,method,p,summary,tag,score,gaps)=>({id,documentId:'d1',definitionId:'def1',definition:'Payments API',method,path:p,summary,tag,deprecated:false,score,gaps,stage:'Uat',updatedAt:iso(-30)});
const eps=[E('e1','POST','/payments','Create a payment','Payments',90,['No error cases']),E('e2','GET','/payments/{id}','Get a payment','Payments',100,[]),E('e3','GET','/refunds','','Refunds',40,['No summary','No description','No success response example'])];
// API drift and freshness: one endpoint whose docs differ from the live API, the API document verified 3 days ago, the BRD out of date.
eps[1].drift={checkedAt:iso(-30),env:'UAT',differs:true,missing:1,extra:1,changed:1,error:null};
const liveCheck={checkedAt:iso(0),env:'UAT',source:'live',status:200,comparedWith:'200',differs:true,error:null,fields:[{path:'penalty',kind:'missing',documented:'number',live:null},{path:'overdueDays',kind:'extra',documented:null,live:'number'},{path:'due',kind:'type',documented:'number',live:'string'}]};
const catalog={projects:[{id:pid,key:'PAY',name:'Payments Core',endpoints:eps,definitions:[{id:'def1',documentId:'d1',name:'Payments API',version:'v1',stage:'Uat',auth:'Bearer',servers:def.servers}],
  documents:[{id:'d1',key:'DOC-1',title:'Payments APIs',typeCode:'API',typeName:'API documentation',typeColor:'#35c491',status:'Published',classification:'Internal',updatedAt:iso(-60),isApi:true,verifiedAt:iso(-3*1440-60)},
   {id:'d3',key:'DOC-3',title:'Payments BRD',typeCode:'BRD',typeName:'Business requirements',typeColor:'#5c7cfa',status:'InReview',classification:'Confidential',updatedAt:iso(-180),isApi:false,staleSince:iso(-120)}],diagrams:1},
  {id:null,key:null,name:'General',endpoints:[],definitions:[],documents:[],diagrams:0}],canCreate:true,isAdmin:true,truncated:0};
// Pages: a handbook with a page inside it, and the page made in the test.
catalog.projects[0].documents.push({id:'p1',key:'DOC-7',title:'Engineering handbook',typeCode:'PAGE',typeName:'Page',typeColor:'#4f46e5',status:'Draft',classification:'Internal',updatedAt:iso(-20),isApi:false,parentId:null,pageOrder:0,icon:'📘'},
 {id:'p2',key:'DOC-8',title:'Code review',typeCode:'PAGE',typeName:'Page',typeColor:'#4f46e5',status:'Draft',classification:'Internal',updatedAt:iso(-25),isApi:false,parentId:'p1',pageOrder:0,icon:null});
const pageItem=(id,title,parentId=null,icon=null)=>({...D(9,title,'PAGE','Page','#4f46e5','Draft'),id,key:id==='pnew'?'DOC-9':'DOC-7',typeId:'t3',parentId,pageOrder:0,icon});
const pageDetail=(id,title,body,rev=1,parentId=null,icon=null)=>({item:pageItem(id,title,parentId,icon),revision:rev,versionLabel:'Draft',publishedLabel:null,hasUnpublishedChanges:false,viewingPublished:false,
  can:{edit:true,delete:true,link:true,share:true,publish:true},maskedCount:0,revealed:false,revealSeconds:0,canReveal:false,sections:[{key:'body',title:'Page',kind:'RichText',sortOrder:0,content:body}]});
let made=null;
const item=(e)=>({id:e.id,definitionId:'def1',definition:'Payments API',method:e.method,path:e.path,summary:e.summary,tag:e.tag,deprecated:false,owner:{id:user.id,name:user.displayName}});
const details=(mobile,pan)=>({description:'Takes a payment.',auth:'inherit',parameters:[{name:'mobile',in:'query',required:true,type:'string',description:'Customer mobile',example:mobile,schema:null}],
  requestBody:{contentType:'application/json',required:true,description:null,schema:null,example:JSON.stringify({pan,amount:500})},responses:[{status:'200',description:'OK',contentType:'application/json',schema:null,example:'{"ok":true}'}],errors:[],samples:[],dependencies:[]});
const masked={item:item(eps[0]),details:details('••••••3210','••••••••4F'),readOnly:false,maskedCount:2,revealed:false,revealSeconds:0,canReveal:true};
const real={...masked,details:details('9876543210','ABCDE1234F'),maskedCount:0,revealed:true,revealSeconds:15};
let arch={projectId:pid,diagrams:[{key:'main',title:'Payments platform',kind:'architecture',data:{nodes:[{id:'a',kind:'icon',icon:'mobile',label:'Mobile app',x:0,y:0,w:150,h:64},{id:'b',kind:'icon',icon:'server',label:'Payments API',x:260,y:0,w:150,h:64}],edges:[{id:'x',source:'a',target:'b',label:'HTTPS',line:'solid'}]}}],notes:'Runs on two zones.',canEdit:true,updatedAt:iso(-90),updatedBy:'Asha Rao'};
const spec={openapi:'3.0.3',info:{title:'Payments API',version:'v1'},servers:[{url:'https://api.example.test/v1'}],paths:{'/payments':{post:{summary:'Create a payment',responses:{200:{description:'OK'}}}}}};
const masking={enabled:true,builtIns:[{label:'Mobile number',strategy:'last4',example:'9876543210',masked:'••••••3210',enabled:true}],rules:[],canManage:true};
const writes=[];
let review={workflowApplies:true,workflowName:'Two-step review',stepCount:2,canSubmit:false,history:[],current:{id:'ap1',state:'Pending',workflowName:'Two-step review',submittedBy:{id:'u2',name:'Ravi Kumar'},submittedAt:iso(-60),summary:'Scope now covers cards',reason:null,major:false,currentStep:0,
  steps:[{name:'Tech lead',who:'Asha Rao',rule:'Any',dueDays:null,state:'Current',people:[]},{name:'Compliance',who:'Compliance team',rule:'Any',dueDays:null,state:'Waiting',people:[]}],canDecide:true,canWithdraw:false,dueAt:null,closedAt:null,closedNote:null}};
const ver=(id,label,o)=>({id,label,major:1,minor:0,isDraft:false,isCurrent:false,changeSummary:null,changeReason:null,publishedAt:iso(-600),publishedBy:{id:user.id,name:user.displayName},restoredFrom:null,contentHash:'h',hasChanges:false,...o});
const versions={items:[ver('v2','Draft',{isDraft:true,hasChanges:true,publishedAt:null,publishedBy:null}),ver('v1','1.0',{isCurrent:true,changeSummary:'First release of the BRD'})],publishedLabel:'1.0',hasUnpublishedChanges:true,nextLabelMinor:'1.1',nextLabelMajor:'2.0'};
const shots=process.env.DOCS_SHOTS||out;
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
   let data=[],status=200;
   const json=(d)=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:d})});
   if(ep==='/api/v1/documents/d1/api/endpoints/e1/reveal'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});await json(real);return;}
   if(ep==='/api/v1/documents/d3/reveal'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});await json({...detail,maskedCount:0,revealed:true,revealSeconds:15,sections:detail.sections.map((x,i)=>i===0?{...x,content:rich('Escalations: 9876543210.')}:x)});return;}
   if(ep==='/api/v1/documents'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});made=pageDetail('pnew',b.title,b.sections?.[0]?.content??rich(''),1,b.parentId??null);await json(made);return;}
   if(ep==='/api/v1/documents/pnew/sections'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});assert.equal(b.revision,made.revision,'each save carries the newest revision');made={...made,revision:made.revision+1,sections:[{...made.sections[0],content:b.sections[0].content}]};await json(made);return;}
   if(ep==='/api/v1/documents/pnew'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});made={...made,revision:made.revision+1,item:{...made.item,title:b.title}};await json(made);return;}
   if(ep==='/api/v1/documents/d3/approve'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});review={...review,current:{...review.current,state:'Approved',canDecide:false,steps:review.current.steps.map((x)=>({...x,state:'Done'}))}};await json(review);return;}
   if(ep==='/api/v1/documents/d1/api/endpoints/e2/live-check'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});await json(liveCheck);return;}
   if(ep==='/api/v1/doctracker/architecture'&&method==='PUT'){const b=req.postDataJSON();writes.push({ep,b});arch={...arch,diagrams:b.diagrams,notes:b.notes};await json(arch);return;}
   if(ep==='/api/v1/documents/d1/api/export'){await route.fulfill({contentType:'application/json',body:JSON.stringify(spec)});return;}
   assert.ok(method==='GET'||ep.endsWith('/auth/refresh')||ep.endsWith('/views'),`Unexpected write: ${method} ${ep}`);
   if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
   else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','docs.create','docs.edit','docs.delete','docs.workflow','docs.secrets','org.manage'],modules:{projects:3,tasks:3,documents:3,calendar:3,work:3,ai:3,activity:3,people:3,reports:3,billing:3,audit:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
   else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
   else if(ep==='/api/v1/projects')data={items:[project],page:1,totalPages:1,totalItems:1};
   else if(ep==='/api/v1/doctracker/catalog')data=catalog;
   else if(ep==='/api/v1/doctracker/architecture')data=arch;
   else if(ep==='/api/v1/documents/d1/api')data={definitions:[def],endpoints:3,live:true,reading:'Working copy',versionId:null,canEdit:true,limit:-1,used:3};
   else if(ep==='/api/v1/documents/d1/api/endpoints/e1')data=masked;
   else if(/^\/api\/v1\/documents\/d1\/api\/endpoints\/e\d$/.test(ep)){const e=eps.find(x=>ep.endsWith('/'+x.id));data={...masked,item:item(e),maskedCount:0};}
   else if(ep==='/api/v1/documents/inbox')data={toReview:[],submitted:[],accessToDecide:[],myAccessRequests:[],waiting:0};
   else if(ep==='/api/v1/documents/dashboard')data={total:2,byStatus:[],byType:[],mine:2,waitingForMe:0,updatedThisWeek:1,notUpdatedIn90Days:0,unpublished:0,recent:docs,projectsMissingRequired:0,requiredTypes:0};
   else if(ep==='/api/v1/documents/required-gaps')data=[];
   else if(ep==='/api/v1/document-security/masking')data=masking;
   else if(ep==='/api/v1/audit-logs')data={items:[{id:'a1',tenantId:ws.id,tenantName:null,userId:user.id,userName:'Asha Rao',action:'api.pii_revealed',entityType:'ApiEndpoint',entityId:'e1',oldValue:null,newValue:'{"purpose":"read","reason":"Partner call"}',ipAddress:null,createdAt:iso(-5)}],page:1,totalPages:1,totalItems:1};
   else if(ep==='/api/v1/documents/d3')data=detail;
   else if(ep==='/api/v1/documents/d3/review')data=review;
   else if(ep==='/api/v1/documents/d3/versions')data=versions;
   else if(ep==='/api/v1/documents/d3/compare')data={from:{id:'v1',label:'1.0',isDraft:false},to:{id:'v2',label:'Draft',isDraft:true},changed:1,added:0,removed:0,unchanged:1,
     sections:[{key:'scope',title:'Scope',kind:'RichText',change:'Changed',lines:[{op:'del',text:'UPI only.',style:'p',words:null},{op:'add',text:'UPI and cards.',style:'p',words:null}],columns:null,rows:null,formattingOnly:false}]};
   else if(ep==='/api/v1/documents/pnew')data=made;
   else if(ep==='/api/v1/documents/p1')data=pageDetail('p1','Engineering handbook',rich('How we work.'),4,null,'📘');
   else if(ep.endsWith('/backlinks'))data=ep.includes('/p1/')?[{id:'p2',key:'DOC-8',title:'Code review',typeCode:'PAGE',typeColor:'#4f46e5',icon:null,projectId:pid}]:[];
   else if(ep==='/api/v1/search')data={hits:[{type:'task',id:'t1',title:'Fix refund rounding',subtitle:'PAY-12',projectId:pid,taskId:'t1'}]};
   else if(ep==='/api/v1/document-types')data=[['BRD','Business requirements','#2563eb','What the business needs and why'],['API','API documentation','#059669','Endpoints, examples and errors'],['SOP','Standard operating procedure','#d97706','Step-by-step instructions for a task'],['PAGE','Page','#4f46e5','A free-form page']].map(([code,name,color,description],i)=>({id:'t'+i,code,name,color,description,icon:'note',sortOrder:i,
     sections:code==='PAGE'?[{key:'body',title:'Page',kind:'RichText',hint:'',columns:null}]:[{key:'steps',title:'Steps',kind:'RichText',hint:'',columns:null},{key:'roles',title:'Roles',kind:'Table',hint:'',columns:['Role','Responsibility']}]}));
   else if(/^\/api\/v1\/documents\/(d3|d1|pnew|p1)\//.test(ep))status=404;
   else if(ep==='/api/v1/timer')data=null;
   else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
   else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
   else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
   else if(ep==='/api/v1/workspace/members')data=[{userId:user.id,displayName:user.displayName,role:'Owner'}];
   else if(ep==='/api/v1/chat/projects/unread')data=[];
   else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
   if(status!==200){await route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:{code:'NOT_FOUND',message:'Not found'}})});return;}
   await json(data);
  });
  return ctx;};
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);await page.screenshot({path:path.join(out,name)});};
 const noScroll=(page)=>fitsPhone(page,'phone',assert);
 let ctx=await make();let page=await ctx.newPage();page.on('pageerror',e=>{errors.push(e.message);console.log('STACK',e.stack?.split('\n').slice(0,6).join(' | '))});page.on('console',m=>{if(m.type()==='error')console.error('console:',m.text().slice(0,300));});await page.setViewportSize({width:1440,height:1000});
 const settle=()=>page.waitForFunction(()=>document.querySelectorAll('.dx-stage').length<=1);
 const big=async(name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(700);await page.screenshot({path:path.join(shots,name)});};

 // Old addresses land on their new places.
 await page.goto(origin+'/preview-org/documents');await page.waitForURL(/\/preview-org\/library$/);
 await page.goto(origin+'/preview-org/library/docs?view=security');await page.waitForURL(/\/library\/security$/);
 await page.goto(origin+`/preview-org/doctracker?p=${pid}&ep=e1`);await page.waitForURL(new RegExp(`/library/p/${pid}/api/e1$`));
 await page.goto(origin+`/preview-org/library/docs?p=${pid}&t=architecture`);await page.waitForURL(new RegExp(`/library/p/${pid}/architecture$`));
 await page.goto(origin+'/preview-org/library/docs?view=home');await page.waitForURL(/\/library$/);checks.push('legacy-redirect');

 // The hub: collections with their health, Start something, search across endpoints, and no DocTracker screens behind ···.
 const coll=page.getByTestId('collection').filter({hasText:'Payments Core'});await coll.waitFor();
 assert.match(await page.getByTestId('collection-missing').first().innerText(),/^(Missing: |Complete)/);   // the space names what its docs are missing
 assert.match(await coll.innerText(),/3 pages · 3 endpoints · 1 diagram/);
 assert.equal(await page.locator('.dx-start').count(),5,'write with AI, a blank page and three templates');
 await page.getByRole('button',{name:'More in Library'}).click();
 assert.deepEqual(await page.getByRole('menu',{name:'More in Library'}).getByRole('menuitem').evaluateAll((els)=>els.map((e)=>e.querySelector('b').textContent)),['Security Center','Approval workflows','Required documents']);
 await page.keyboard.press('Escape');
 await page.getByRole('searchbox',{name:'Ask your docs'}).fill('refunds');
 const hit=page.locator('.dx-results .dx-li',{hasText:'/refunds'});await hit.waitFor();
 assert.equal(await hit.getAttribute('href'),`/preview-org/library/p/${pid}/api/e3`);
 await page.getByRole('searchbox',{name:'Ask your docs'}).fill('');
 await page.locator('.dx-colls').waitFor();await big('docs-hub.png');checks.push('hub');

 // A template starts a free-form page with its headings; the title is selected, "/" makes a callout, "@" mentions a person, and it saves itself.
 await page.locator('.dx-start',{hasText:'Standard operating procedure'}).click();
 const created=writes.find(w=>w.ep==='/api/v1/documents').b;assert.equal(created.typeId,'t3');assert.match(created.sections[0].content,/"text":"Steps"/);assert.match(created.sections[0].content,/"tableHeader"/);
 await page.locator('.pg-title').waitFor();assert.equal(await page.locator('.pg-title').inputValue(),'Standard operating procedure');
 assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('pg-title')),true,'the new page is ready to name');
 await page.locator('.pg-title').fill('Refund SOP');await page.keyboard.press('Enter');
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/documents/pnew'&&w.b.title);i++)await page.waitForTimeout(100);assert.equal(writes.find(w=>w.ep==='/api/v1/documents/pnew').b.title,'Refund SOP');
 await page.locator('.pg-body .ProseMirror h2',{hasText:'Steps'}).waitFor();
 await page.locator('.pg-body .ProseMirror p').first().click();await page.keyboard.type('/call');await page.locator('.sgm-item',{hasText:'Callout'}).waitFor();await page.waitForTimeout(150);
 await page.keyboard.press('Enter');await page.keyboard.type('Customers get refunds in 5 days. Ask ');await page.keyboard.type('@As');await page.locator('.sgm-item',{hasText:'Asha Rao'}).waitFor();await page.keyboard.press('Enter');
 for(let i=0;i<40&&!writes.some(w=>w.ep==='/api/v1/documents/pnew/sections'&&/"mention"/.test(w.b.sections[0].content));i++)await page.waitForTimeout(100);
 const savedBody=writes.filter(w=>w.ep==='/api/v1/documents/pnew/sections').at(-1).b.sections[0].content;
 assert.match(savedBody,/"type":"callout"/);assert.match(savedBody,/"kind":"person"/);
 await page.locator('.pg-save',{hasText:/Saved/}).waitFor();checks.push('template-page');
 // Pages inside pages: "Add a page" under Pages inside adds one inside this page.
 await page.goto(origin+'/preview-org/documents/p1');await page.locator('.pg-title').waitFor();
 await page.locator('.pg-under .pg-list a',{hasText:'Code review'}).first().waitFor();
 const before=writes.filter(w=>w.ep==='/api/v1/documents').length;
 await page.getByTestId('doc-crumb').waitFor();
 await page.locator('.pg-under').getByRole('button',{name:'Add a page'}).click();
 for(let i=0;i<20&&writes.filter(w=>w.ep==='/api/v1/documents').length===before;i++)await page.waitForTimeout(100);
 assert.equal(writes.filter(w=>w.ep==='/api/v1/documents').at(-1).b.parentId,'p1');checks.push('pages');

 // A project's documentation: topic navigator (Overview, Guides as a tree, API Reference by resource, Architecture, Release notes).
 await page.goto(origin+`/preview-org/library/p/${pid}`);
 const nav=page.getByTestId('topic-nav');await nav.waitFor();
 assert.deepEqual(await nav.locator('.dx-group > .dx-group-h > button:first-child span').allInnerTexts(),['Guides','API Reference','Payments','Refunds','Release notes']);
 assert.equal(await nav.locator('.dx-nav-row.ep').count(),3);
 await nav.locator('.dx-tree-row',{hasText:'Engineering handbook'}).waitFor();
 await page.locator('.dx-title',{hasText:'Payments Core'}).waitFor();
 await page.locator('.dx-api',{hasText:'Payments API'}).waitFor();
 await page.locator('section[data-outline="Needs work"] .dx-li',{hasText:'/refunds'}).waitFor();
 assert.deepEqual(await page.getByTestId('docs-crumb').locator('a').allInnerTexts(),['Library']);
 await page.getByTestId('doc-outline').waitFor();
 assert.match(await page.getByTestId('doc-outline').innerText(),/APIs[\s\S]*Guides[\s\S]*Needs work[\s\S]*Architecture/);
 if(process.env.WHY){const c=await page.context().newCDPSession(page);await c.send('DOM.enable');await c.send('CSS.enable');const {root}=await c.send('DOM.getDocument');const {nodeId}=await c.send('DOM.querySelector',{nodeId:root.nodeId,selector:'.dx-title'});const m=await c.send('CSS.getMatchedStylesForNode',{nodeId});for(const r of m.matchedCSSRules)if(r.rule.style.cssProperties.some(x=>x.name==='color'))console.log('RULE',r.rule.selectorList.text,r.rule.style.cssProperties.filter(x=>x.name==='color').map(x=>x.value));for(const i of m.inherited||[])for(const r of i.matchedCSSRules)if(r.rule.style.cssProperties.some(x=>x.name==='color'))console.log('INH',r.rule.selectorList.text.slice(0,120),r.rule.style.cssProperties.filter(x=>x.name==='color').map(x=>x.value));process.exit(0);}
 await big('docs-project.png');checks.push('project-docs','outline');
 // The navigator's filter.
 await nav.getByLabel('Filter topics').fill('refund');
 await page.waitForFunction(()=>document.querySelectorAll('[data-testid="topic-nav"] .dx-nav-row.ep').length===1);
 await nav.getByLabel('Filter topics').fill('');checks.push('navigator-filter');

 // An endpoint as an API symbol page.
 await nav.locator('.dx-nav-row.ep',{hasText:'Create a payment'}).click();await page.waitForURL(/\/api\/e1$/);
 const sym=page.getByTestId('api-symbol');await sym.waitFor();
 await settle();assert.equal(await sym.locator('.dx-title').innerText(),'Create a payment');
 assert.equal(await sym.locator('.dx-m').innerText(),'POST');
 assert.deepEqual(await page.getByTestId('docs-crumb').locator('a').allInnerTexts(),['Library','Payments Core']);
 assert.deepEqual(await page.getByTestId('env-switch').getByRole('radio').allInnerTexts(),['PROD']);
 assert.match(await page.locator('.dx-decl').innerText(),/POST https:\/\/api\.example\.test\/v1\/payments/);
 const param=page.getByTestId('params').locator('.dx-param',{hasText:'mobile'});assert.match(await param.innerText(),/mobile\s*Query\s*string\s*Required[\s\S]*Customer mobile/);
 await page.getByTestId('params').locator('.dx-param',{hasText:'pan'}).waitFor();
 const req=page.getByTestId('code-request-examples');
 assert.deepEqual(await req.getByRole('tab').allInnerTexts(),['cURL','JSON']);
 assert.match(await req.locator('pre').innerText(),/curl --request POST "https:\/\/api\.example\.test\/v1\/payments"[\s\S]*Authorization: Bearer <token>/);
 await req.getByRole('tab',{name:'JSON'}).click();await req.locator('pre',{hasText:'"amount": 500'}).waitFor();
 await page.locator('section[data-outline="Status codes"] .dx-sc',{hasText:'200'}).waitFor();
 await page.locator('section[data-outline="Health"]',{hasText:'No error cases'}).waitFor();checks.push('api-symbol','code-tabs');
 await req.getByRole('tab',{name:'cURL'}).click();await page.getByTestId('docs-crumb').scrollIntoViewIfNeeded();await page.evaluate(()=>{window.scrollTo(0,0);document.querySelectorAll('*').forEach((e)=>{if(e.scrollTop>0)e.scrollTop=0;});});await big('docs-api.png');
 // Masked values and an audited reveal.
 await page.locator('.dx-mask',{hasText:'2 values masked'}).waitFor();
 assert.ok(await page.getByText('••••••3210',{exact:false}).first().isVisible());
 await page.locator('.dx-mask').getByRole('button',{name:'Reveal'}).click();
 const dlg=page.getByRole('dialog');await dlg.getByLabel('Why do you need to see them?').fill('Partner integration call');await dlg.getByRole('button',{name:'Reveal'}).click();
 await page.locator('.dx-mask.open').waitFor();assert.ok(await page.getByText('9876543210',{exact:false}).first().isVisible());
 assert.equal(writes.find(w=>w.ep.endsWith('/e1/reveal')).b.purpose,'read');
 await page.getByRole('button',{name:'Hide now'}).click();await page.locator('.dx-mask:not(.open)').waitFor();
 await page.getByRole('button',{name:'···'}).click();await page.getByRole('menuitem',{name:/Raw JSON/}).click();
 await page.getByTestId('code-raw').locator('pre',{hasText:'"mobile"'}).waitFor();
 assert.ok(!(await page.getByTestId('code-raw').innerText()).includes('9876543210'));
 await page.getByRole('button',{name:'···'}).click();await page.getByRole('menuitem',{name:/Reference view/}).click();checks.push('endpoint-mask-reveal','json-view');
 // Try it: the request is written for the environment; Run unfurls the documented response.
 await page.locator('section[data-outline="Try it"]').getByRole('button',{name:'Try it'}).click();
 const tryIt=page.getByTestId('try-it');await tryIt.waitFor();
 await tryIt.getByRole('textbox').first().fill('9000000001');
 assert.match(await tryIt.getByTestId('code-your-request').locator('pre').innerText(),/payments\?mobile=9000000001/);
 await tryIt.getByRole('button',{name:'Run'}).click();
 const resp=page.getByTestId('try-response');await resp.locator('.dx-sc',{hasText:'200'}).waitFor();
 assert.match(await resp.innerText(),/OK[\s\S]*content-type[\s\S]*application\/json[\s\S]*"ok": true/);
 await tryIt.scrollIntoViewIfNeeded();await big('docs-api-try.png');checks.push('try-it');
 // Edit unlocks the real values (audited as editing).
 await page.locator('.dx-tools').getByRole('button',{name:'Edit'}).click();
 await page.getByRole('dialog').getByRole('tab',{name:'Parameters'}).click();
 assert.equal(await page.getByRole('dialog').getByLabel('Example').first().inputValue(),'9876543210');
 assert.equal(writes.filter(w=>w.ep.endsWith('/e1/reveal'))[1].b.purpose,'edit');
 await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();checks.push('edit-unlock');
 // Outline follows the scroll.
 await page.locator('section[data-outline="Relationships"]').scrollIntoViewIfNeeded();await page.waitForTimeout(500);
 assert.notEqual(await page.locator('.rd-toc li.on').innerText(),'Declaration','the outline marks the section in view');checks.push('outline-follows');

 // Architecture: a saved diagram previews; edit the title in the studio and Done saves for the project.
 await nav.locator('.dx-nav-row',{hasText:'Architecture'}).click();await page.waitForURL(/\/architecture$/);
 await page.locator('.dx-fig',{hasText:'Payments platform'}).waitFor();
 await page.locator('.dx-fig .react-flow__node',{hasText:'Mobile app'}).waitFor();
 await shot(page,'architecture-1440.png');
 await page.getByRole('button',{name:'Edit Payments platform'}).click();
 await page.getByLabel('Diagram title').fill('Payments platform v2');
 await page.getByRole('button',{name:'Done'}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/doctracker/architecture');i++)await page.waitForTimeout(100);
 const saved=writes.find(w=>w.ep==='/api/v1/doctracker/architecture').b;
 assert.equal(saved.diagrams[0].title,'Payments platform v2');assert.equal(saved.diagrams[0].data.nodes.length,2);
 await page.locator('.dx-fig',{hasText:'Payments platform v2'}).waitFor();checks.push('architecture-studio');

 // Swagger, read only (no "Try it out"), from the overview's Export menu.
 await nav.locator('.dx-nav-row',{hasText:'Overview'}).click();await page.locator('.dx-api').waitFor();
 await page.getByRole('button',{name:'Export'}).click();await page.getByRole('menuitem',{name:/Open in Swagger/}).click();
 await page.locator('.dx-sheet .opblock-summary-path',{hasText:'/payments'}).waitFor({timeout:15000});
 await page.locator('.dx-sheet .opblock-summary').first().click();await page.waitForTimeout(300);
 assert.equal(await page.locator('.dx-sheet .try-out__btn:visible').count(),0);
 await page.locator('.dx-sheet header').getByRole('button',{name:'Done'}).click();checks.push('swagger');

 // Security Center: masking rules, audit log.
 await page.goto(origin+'/preview-org/library');await page.getByRole('button',{name:'More in Library'}).click();await page.getByRole('menuitem',{name:/Security Center/}).click();
 await page.getByTestId('security-center').locator('.dx-h1',{hasText:'Security Center'}).waitFor();
 await page.locator('.dx-sec-body',{hasText:'Mobile number'}).waitFor();
 await page.getByRole('tab',{name:'Audit log'}).click();await page.locator('.dx-events code',{hasText:'api.pii_revealed'}).waitFor();
 await shot(page,'security-1440.png');checks.push('security-center');

 // A document read inside its project: crumb, reveal, review (approve), versions with a diff, and the floating edit toolbar.
 await page.goto(origin+`/preview-org/library/p/${pid}/d/d3`);await page.locator('.rd-title',{hasText:'Payments BRD'}).waitFor();
 assert.deepEqual(await page.getByTestId('doc-crumb').locator('a').allInnerTexts(),['Library','Payments Core']);
 assert.equal(await page.getByTestId('doc-crumb').locator('a').nth(1).getAttribute('href'),`/preview-org/library/p/${pid}`);
 await page.getByTestId('topic-nav').locator('.dx-nav-row.on',{hasText:'Payments BRD'}).waitFor();
 await page.locator('.dv-mask').getByRole('button',{name:'Reveal'}).click();
 const d2=page.getByRole('dialog');await d2.getByLabel('Why do you need to see them?').fill('Escalation review');await d2.getByRole('button',{name:'Reveal'}).click();
 await page.locator('.dv-mask.revealed').waitFor();checks.push('document-reveal');
 await page.locator('.dx-rvw-note',{hasText:'Waiting for your review'}).click();
 const rv=page.getByTestId('review-inspector');await rv.waitFor();
 assert.match(await rv.innerText(),/Step 1 of 2[\s\S]*Your turn[\s\S]*Scope now covers cards[\s\S]*Tech lead[\s\S]*Compliance/);
 await rv.getByRole('button',{name:'Approve'}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/documents/d3/approve');i++)await page.waitForTimeout(100);
 assert.ok(writes.some(w=>w.ep==='/api/v1/documents/d3/approve'));checks.push('review-inspector');
 await page.getByRole('button',{name:'Versions'}).click();
 const vers=page.getByTestId('versions');await vers.waitFor();
 assert.match(await vers.innerText(),/Working draft[\s\S]*Unpublished[\s\S]*v1\.0[\s\S]*Current[\s\S]*First release of the BRD/);
 await vers.getByRole('button',{name:'Changes',exact:true}).click();
 await page.getByTestId('version-stage').getByText('UPI and cards.').first().waitFor();
 await page.getByTestId('version-stage').getByRole('button',{name:'Back to the document'}).click();checks.push('versions-diff');
 await page.getByRole('button',{name:/Sharing & access/}).click();await page.locator('.dx-share').waitFor();
 await page.getByRole('button',{name:/Related docs/}).click();await page.locator('#rd-ins-related .rd-ins-body').waitFor();checks.push('inspector');
 await page.locator('.rd-tools').getByRole('button',{name:'Edit'}).click();
 const bar=page.getByTestId('edit-toolbar');await bar.waitFor();
 assert.match(await bar.innerText(),/All changes saved[\s\S]*Done[\s\S]*Save/);
 assert.equal(await bar.evaluate((e)=>getComputedStyle(e).position),'fixed');
 await page.locator('.rd-sec').last().locator('.ProseMirror').click();await page.keyboard.type(' More detail.');
 await bar.getByText('Unsaved changes').waitFor();
 await big('docs-edit.png');
 await bar.getByRole('button',{name:'Done'}).click();checks.push('edit-toolbar');
 await noScroll(page);
 await page.close();await ctx.close();

 // Freshness on every page, API drift on the endpoint and in Out of date, and a link to one diagram.
 ctx=await make();await ctx.grantPermissions(['clipboard-read','clipboard-write'],{origin});page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/library');
 const ood=page.getByTestId('out-of-date');await ood.waitFor();
 assert.match(await ood.innerText(),/GET \/payments\/\{id\} — Docs differ from live API \(3 fields on UAT\)/);
 assert.equal(await ood.getByRole('link',{name:'Review it ›'}).getAttribute('href'),`/preview-org/library/p/${pid}/api/e2`);checks.push('out-of-date-drift');
 await page.goto(origin+`/preview-org/library/p/${pid}`);await page.locator('.dx-title',{hasText:'Payments Core'}).waitFor();
 assert.equal((await page.getByTestId('fresh-pill').first().innerText()).trim(),'May be stale','a collection with an out-of-date page may be stale');
 await page.goto(origin+`/preview-org/library/p/${pid}/api`);await page.locator('.dx-title',{hasText:'Payments Core API'}).waitFor();
 assert.equal((await page.getByTestId('fresh-pill').innerText()).trim(),'Verified 3 days ago');
 await page.locator('.dx-li',{hasText:'/payments/{id}'}).getByText('Differs from live').waitFor();
 await page.goto(origin+`/preview-org/library/p/${pid}/api/e2`);await page.getByTestId('api-symbol').waitFor();
 assert.equal((await page.getByTestId('fresh-pill').innerText()).trim(),'Verified 3 days ago');
 await page.getByTestId('drift-pill').filter({hasText:'Docs differ from live API'}).waitFor();await big('endpoint-top-1440.png');
 const lc=page.getByTestId('live-check');await lc.scrollIntoViewIfNeeded();
 await lc.getByRole('button',{name:/Check against live · /}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep.endsWith('/e2/live-check'));i++)await page.waitForTimeout(100);
 const sent=writes.find(w=>w.ep.endsWith('/e2/live-check')).b;assert.equal(typeof sent.env,'number');assert.ok(!JSON.stringify(sent).includes('example.test'),'the browser sends no address');
 await lc.locator('li',{hasText:'penalty'}).waitFor();await lc.locator('li',{hasText:'number in docs → string live'}).waitFor();
 assert.ok(!(await lc.innerText()).includes('example.test'),'no hostnames in the live check');
 await lc.screenshot({path:path.join(out,'live-check.png')});await big('endpoint-drift-1440.png');checks.push('live-check');
 await page.goto(origin+`/preview-org/library/p/${pid}/d/d3`);await page.locator('.dx-guide-fresh').waitFor();
 assert.equal((await page.getByTestId('fresh-pill').innerText()).trim(),'May be stale');checks.push('guide-fresh');
 arch={...arch,diagrams:[...arch.diagrams,{key:'flow-2',title:'Refund flow',kind:'flow',data:{nodes:[{id:'r',kind:'icon',icon:'api',label:'Refunds',x:0,y:0,w:150,h:64}],edges:[]}}]};
 await page.goto(origin+`/preview-org/library/p/${pid}/architecture`);await page.getByTestId('arch-gallery').waitFor();
 assert.equal(await page.locator('.dx-fig').count(),2);assert.match((await page.getByTestId('fresh-pill').innerText()).trim(),/^Verified (today|\d+ days? ago)$/);
 await page.getByRole('button',{name:'Copy a link to Refund flow'}).click();
 const link=await page.evaluate(()=>navigator.clipboard.readText());assert.equal(link,`${origin}/preview-org/library/p/${pid}/architecture?diagram=flow-2`,'Share copies the one-diagram address');
 checks.push('diagram-share');
 await page.goto(origin+`/preview-org/library/p/${pid}/architecture?diagram=flow-2`);await page.getByTestId('arch-gallery').waitFor();
 assert.equal(await page.locator('.dx-fig').count(),1);await page.locator('.dx-fig figcaption',{hasText:'Refund flow'}).waitFor();checks.push('diagram-link');
 await page.close();await ctx.close();
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
 await page.goto(origin+`/preview-org/library/p/${pid}/api/e2`);await page.getByTestId('api-symbol').waitFor();await page.getByTestId('drift-pill').waitFor();
 await noScroll(page);await shot(page,'endpoint-drift-390.png');await page.getByTestId('live-check').scrollIntoViewIfNeeded();await noScroll(page);await shot(page,'live-check-390.png');
 arch={...arch,diagrams:arch.diagrams.filter((d)=>d.key!=='flow-2')};
 await page.close();await ctx.close();

 // Phone: the navigator sits above the column; pages fit.
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>{errors.push(e.message);console.log('STACK',e.stack?.split('\n').slice(0,6).join(' | '))});await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/doctracker?p='+pid);await page.waitForURL(new RegExp(`/library/p/${pid}$`));await page.locator('.dx-title').waitFor();
 await noScroll(page);await shot(page,'project-390.png');
 await page.getByTestId('topic-nav').locator('.dx-nav-row.ep',{hasText:'/refunds'}).click();await page.getByTestId('api-symbol').waitFor();await noScroll(page);
 await shot(page,'endpoint-390.png');
 await page.goto(origin+'/preview-org/library');await page.getByTestId('collection').first().waitFor();await noScroll(page);checks.push('phone');
 await page.close();await ctx.close();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,errors}));
}finally{await browser.close();}
