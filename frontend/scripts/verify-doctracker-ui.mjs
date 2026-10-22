import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';

// DocTracker: the Control Center, the project tree (overview ▸ architecture ▸ documents ▸ tags ▸ endpoints), an endpoint with masked
// values and an audited reveal, the JSON view, Architecture Studio saving per project, Swagger (read only), the Security Center, "/"
// search, a document beside the DocTracker tree, the old /documents link, and the phone drawer. Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/doctracker-ui');
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
const docs=[D(1,'Payments APIs','API','API documentation','#35c491','Published'),D(3,'Payments BRD','BRD','Business requirements','#5c7cfa','InReview','Confidential')];
const rich=(t)=>JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:t}]}]});
const detail={item:docs[1],revision:3,versionLabel:'v1.0',publishedLabel:'v1.0',hasUnpublishedChanges:false,viewingPublished:false,
  can:{edit:true,delete:true,link:true,share:true,publish:true},maskedCount:1,revealed:false,revealSeconds:0,canReveal:true,
  sections:[{key:'overview',title:'Overview',kind:'RichText',sortOrder:0,content:rich('Escalations: ••••••3210.')},{key:'scope',title:'Scope',kind:'RichText',sortOrder:1,content:rich('UPI and cards.')}]};
const def={id:'def1',name:'Payments API',description:null,basePath:'/v1',version:'v1',auth:'Bearer',authNote:null,servers:['https://api.example.test'],endpoints:3,sortOrder:0,stage:'Uat'};
const E=(id,method,p,summary,tag,score,gaps)=>({id,documentId:'d1',definitionId:'def1',definition:'Payments API',method,path:p,summary,tag,deprecated:false,score,gaps,stage:'Uat',updatedAt:iso(-30)});
const eps=[E('e1','POST','/payments','Create a payment','Payments',90,['No error cases']),E('e2','GET','/payments/{id}','Get a payment','Payments',100,[]),E('e3','GET','/refunds','','Refunds',40,['No summary','No description','No success response example'])];
const catalog={projects:[{id:pid,key:'PAY',name:'Payments Core',endpoints:eps,definitions:[{id:'def1',documentId:'d1',name:'Payments API',version:'v1',stage:'Uat',auth:'Bearer',servers:def.servers}],
  documents:[{id:'d1',key:'DOC-1',title:'Payments APIs',typeCode:'API',typeName:'API documentation',typeColor:'#35c491',status:'Published',classification:'Internal',updatedAt:iso(-60),isApi:true},
   {id:'d3',key:'DOC-3',title:'Payments BRD',typeCode:'BRD',typeName:'Business requirements',typeColor:'#5c7cfa',status:'InReview',classification:'Confidential',updatedAt:iso(-180),isApi:false}],diagrams:1},
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

 // The old Documents link lands in DocTracker; the Control Center sums up scores.
 await page.goto(origin+'/preview-org/documents');await page.waitForURL(/\/doctracker/);
 await page.locator('.dt-home .dt-hero',{hasText:'API quality'}).waitFor();
 assert.equal(await page.locator('.dl-starter').count(),4,'a blank page and three templates');await page.locator('.dl-rows .dl-row',{hasText:'Payments BRD'}).first().waitFor();
 assert.equal(await page.locator('.dt-kpis').count(),0,'no wall of counters');
 await page.getByLabel('Search DocTracker').fill('refunds');await page.locator('.dl-section[aria-label="Search results"] .dl-row',{hasText:'/refunds'}).waitFor();await page.getByLabel('Search DocTracker').fill('');
 assert.equal((await page.locator('.dt-hero .dt-ring b').first().textContent()).trim(),'77');   // (90+100+40)/3
 await page.locator('.dt-weak li',{hasText:'/refunds'}).waitFor();
 assert.equal(await page.locator('.dt-weak li').count(),1);
 await page.waitForTimeout(900);await page.screenshot({path:path.join(out,'control-center-1440.png'),fullPage:true,animations:'disabled'});checks.push('legacy-redirect','control-center');
 // A template starts a free-form page with its headings; the title is selected, "/" makes a callout, "@" mentions a person, and it saves itself.
 await page.locator('.dl-starter',{hasText:'Standard operating procedure'}).click();
 const created=writes.find(w=>w.ep==='/api/v1/documents').b;assert.equal(created.typeId,'t3');assert.match(created.sections[0].content,/"text":"Steps"/);assert.match(created.sections[0].content,/"tableHeader"/);
 await page.locator('.pg-title').waitFor();assert.equal(await page.locator('.pg-title').inputValue(),'Standard operating procedure');
 assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('pg-title')),true,'the new page is ready to name');
 await page.locator('.pg-title').fill('Refund SOP');await page.keyboard.press('Enter');
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/documents/pnew'&&w.b.title);i++)await page.waitForTimeout(100);assert.equal(writes.find(w=>w.ep==='/api/v1/documents/pnew').b.title,'Refund SOP');
 await page.locator('.pg-body .ProseMirror h2',{hasText:'Steps'}).waitFor();
 await page.locator('.pg-body .ProseMirror p').first().click();await page.keyboard.type('/call');await page.locator('.sgm-item',{hasText:'Callout'}).waitFor();await page.waitForTimeout(150);await shot(page,'page-slash-1440.png');
 await page.keyboard.press('Enter');await page.keyboard.type('Customers get refunds in 5 days. Ask ');await page.keyboard.type('@As');await page.locator('.sgm-item',{hasText:'Asha Rao'}).waitFor();await page.keyboard.press('Enter');
 for(let i=0;i<40&&!writes.some(w=>w.ep==='/api/v1/documents/pnew/sections'&&/"mention"/.test(w.b.sections[0].content));i++)await page.waitForTimeout(100);
 const savedBody=writes.filter(w=>w.ep==='/api/v1/documents/pnew/sections').at(-1).b.sections[0].content;
 assert.match(savedBody,/"type":"callout"/);assert.match(savedBody,/"kind":"person"/);assert.match(savedBody,/Customers get refunds in 5 days/);
 await page.locator('.pg-save',{hasText:/Saved/}).waitFor();await page.waitForTimeout(200);await shot(page,'page-1440.png');
 // The tree shows pages inside pages, and "+" on a page adds one inside it.
 await page.goto(origin+'/preview-org/documents/p1');await page.locator('.pg-title').waitFor();
 await page.locator('.pg-under .pg-list a',{hasText:'Code review'}).first().waitFor();
 const before=writes.filter(w=>w.ep==='/api/v1/documents').length;
 await page.locator('.dt-page-row',{hasText:'Engineering handbook'}).hover();await page.getByRole('button',{name:'Add a page inside Engineering handbook'}).click();
 for(let i=0;i<20&&writes.filter(w=>w.ep==='/api/v1/documents').length===before;i++)await page.waitForTimeout(100);
 assert.equal(writes.filter(w=>w.ep==='/api/v1/documents').at(-1).b.parentId,'p1');checks.push('pages');
 await page.goto(origin+'/preview-org/doctracker');await page.locator('.dt-home').waitFor();

 // The tree: project ▸ overview, architecture, documents, tags ▸ endpoints.
 await page.getByRole('button',{name:'Open Payments Core'}).click();
 await page.locator('.ds-type-head',{hasText:'Payments'}).waitFor();
 assert.equal(await page.locator('.ds-type').filter({has:page.locator('.ds-type-name',{hasText:/^Payments$/})}).locator('.dt-ep-row').count(),2);
 await page.locator('.dt-ep-row',{hasText:'/refunds'}).waitFor();checks.push('tree');

 // Project overview: KPIs and the API card.
 await page.locator('.ds-node-main',{hasText:'Payments Core'}).click();
 await page.locator('.dt-phead h2',{hasText:'Payments Core'}).waitFor();
 await page.locator('.dt-api',{hasText:'Payments API'}).waitFor();
 await shot(page,'project-overview-1440.png');checks.push('project-overview');

 // An endpoint: masked values, an audited reveal, JSON view.
 await page.locator('.dt-ep-row',{hasText:'/payments'}).first().click();
 await page.locator('.dt-mask',{hasText:'2 values masked'}).waitFor();
 assert.ok(await page.getByText('••••••3210',{exact:false}).first().isVisible());
 await page.locator('.dt-score',{hasText:'No error cases'}).waitFor();
 await page.locator('.dt-mask').getByRole('button',{name:'Reveal'}).click();
 const dlg=page.getByRole('dialog');await dlg.getByLabel('Why do you need to see them?').fill('Partner integration call');await dlg.getByRole('button',{name:'Reveal'}).click();
 await page.locator('.dt-mask.open').waitFor();assert.ok(await page.getByText('9876543210',{exact:false}).first().isVisible());
 assert.equal(writes.find(w=>w.ep.endsWith('/e1/reveal')).b.purpose,'read');
 await shot(page,'endpoint-revealed-1440.png');
 await page.getByRole('button',{name:'Hide now'}).click();await page.locator('.dt-mask:not(.open)').waitFor();
 await page.getByRole('radio',{name:'JSON'}).click();await page.locator('.dt-json pre',{hasText:'"mobile"'}).waitFor();
 assert.ok(!(await page.locator('.dt-json pre').textContent()).includes('9876543210'));checks.push('endpoint-mask-reveal','json-view');
 // Edit unlocks the real values (audited as editing).
 await page.getByRole('radio',{name:'Reference'}).click();
 await page.locator('.apv-tools').getByRole('button',{name:'Edit'}).click();
 await page.getByRole('dialog').getByRole('tab',{name:'Parameters'}).click();
 assert.equal(await page.getByRole('dialog').getByLabel('Example').first().inputValue(),'9876543210');
 assert.equal(writes.filter(w=>w.ep.endsWith('/e1/reveal'))[1].b.purpose,'edit');
 await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();checks.push('edit-unlock');

 // Architecture: a saved diagram previews; edit the title in the studio and Done saves for the project.
 await page.locator('.ds-doc-row',{hasText:'Architecture'}).click();
 await page.locator('.dt-arch-card',{hasText:'Payments platform'}).waitFor();
 await page.locator('.dt-arch-card .react-flow__node',{hasText:'Mobile app'}).waitFor();
 await shot(page,'architecture-1440.png');
 await page.getByRole('button',{name:'Edit Payments platform'}).click();
 await page.getByLabel('Diagram title').fill('Payments platform v2');
 await page.getByRole('button',{name:'Done'}).click();
 for(let i=0;i<20&&!writes.some(w=>w.ep==='/api/v1/doctracker/architecture');i++)await page.waitForTimeout(100);
 const saved=writes.find(w=>w.ep==='/api/v1/doctracker/architecture').b;
 assert.equal(saved.diagrams[0].title,'Payments platform v2');assert.equal(saved.diagrams[0].data.nodes.length,2);
 await page.locator('.dt-arch-card',{hasText:'Payments platform v2'}).waitFor();checks.push('architecture-studio');

 // Swagger, read only (no "Try it out").
 await page.locator('.ds-node-main',{hasText:'Payments Core'}).click();
 await page.getByRole('button',{name:'Open in Swagger'}).click();
 await page.locator('.dt-swagger .opblock-summary-path',{hasText:'/payments'}).waitFor({timeout:15000});
 await page.locator('.dt-swagger .opblock-summary').first().click();await page.waitForTimeout(300);
 assert.equal(await page.locator('.dt-swagger .try-out__btn:visible').count(),0);
 await shot(page,'swagger-1440.png');
 await page.locator('.dt-swagger header').getByRole('button',{name:'Close'}).click();checks.push('swagger');

 // "/" jumps to the search across endpoints.
 await page.keyboard.press('/');await page.keyboard.type('refund');
 await page.locator('.dt-tree .dt-ep-row',{hasText:'/refunds'}).waitFor();assert.equal(await page.locator('.dt-tree .dt-ep-row').count(),1);
 await page.getByLabel('Search APIs, endpoints and documents').fill('');checks.push('search');

 // Security Center: masking rules, audit log.
 await page.getByRole('button',{name:'Manage'}).click();await page.getByRole('menuitem',{name:/Security Center/}).click();
 await page.locator('.dt-sec .dt-hero',{hasText:'Security Center'}).waitFor();
 await page.locator('.dt-sec-body',{hasText:'Mobile number'}).waitFor();
 await page.getByRole('tab',{name:'Audit log'}).click();await page.locator('.dt-audit code',{hasText:'api.pii_revealed'}).waitFor();
 await shot(page,'security-1440.png');checks.push('security-center');
 await noScroll(page);

 // A document opens beside the DocTracker tree, with its own masking.
 await page.goto(origin+'/preview-org/documents/d3');await page.locator('.dv-head h1',{hasText:'Payments BRD'}).waitFor();
 await page.locator('.dt-tree .ds-doc.active',{hasText:'Payments BRD'}).waitFor();
 await page.locator('.dv-mask').getByRole('button',{name:'Reveal'}).click();
 const d2=page.getByRole('dialog');await d2.getByLabel('Why do you need to see them?').fill('Escalation review');await d2.getByRole('button',{name:'Reveal'}).click();
 await page.locator('.dv-mask.revealed').waitFor();
 await shot(page,'document-beside-tree-1440.png');checks.push('document-tree');
 await page.keyboard.press('Control+\\');await page.locator('.ds-shell.collapsed').waitFor();
 await page.getByRole('button',{name:'Show document tree'}).click();await page.locator('.ds-shell:not(.collapsed)').waitFor();checks.push('collapse');
 await noScroll(page);
 await page.close();await ctx.close();

 // Phone: the tree is a drawer, pages fit.
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>{errors.push(e.message);console.log('STACK',e.stack?.split('\n').slice(0,6).join(' | '))});await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/doctracker?p='+pid);await page.locator('.dt-phead h2').waitFor();
 assert.equal(await page.locator('.ds-shell-side').isVisible(),false);await noScroll(page);
 await shot(page,'project-390.png');
 await page.getByRole('button',{name:'Browse DocTracker'}).click();await page.locator('.ds-drawer .dt-tree').waitFor();
 await page.locator('.ds-drawer .dt-ep-row',{hasText:'/refunds'}).click();await page.locator('.dt-ep .apv-banner').waitFor();await noScroll(page);
 await shot(page,'endpoint-390.png');checks.push('phone');
 await page.close();await ctx.close();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,errors}));
}finally{await browser.close();}
