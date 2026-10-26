import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// The organization's own Claude or ChatGPT key: an admin checks a key with the provider (its model list is the proof it works), picks the
// three models and saves; afterwards only the key's last four characters are shown. A person who has not agreed sees a quiet notice above
// the assistant's box; their first question is held, they are asked once, and after agreeing the same question is sent. They can withdraw
// in My account. Synthetic API fixtures only: no provider, no model, no key ever leaves the page.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve(process.env.PM_UI_ARTIFACTS||'test-results/enterprise-ui','own-ai');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false,mfaEnabled:true};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4,timeZone:null};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const perms=['org.manage','access.manage','members.manage','audit.view','projects.view','tasks.view','work.view','reports.view'];
const GOOD='sk-ant-good-preview-0000cdef', BAD='sk-ant-bad-preview-00000000';
const MODELS=['claude-haiku-5-5','claude-opus-5-5','claude-sonnet-5-5'];
const now=new Date().toISOString();
let saved=null, agreed=false;
const settings=()=>saved
 ?{configured:true,provider:'anthropic',providerName:'Claude (Anthropic)',keyHint:'cdef',quickModel:saved.quickModel,standardModel:saved.standardModel,deepModel:saved.deepModel,enabled:saved.enabled,fallbackToPlatform:saved.fallbackToPlatform,lastCheckedAt:now,lastError:null,peopleAgreed:agreed?1:0,version:1}
 :{configured:false,provider:'anthropic',providerName:'Claude (Anthropic)',keyHint:null,quickModel:'claude-haiku-5-5',standardModel:'claude-sonnet-5-5',deepModel:'claude-opus-5-5',enabled:false,fallbackToPlatform:true,lastCheckedAt:null,lastError:null,peopleAgreed:0,version:0};
const notice='Preview Workspace answers the assistant with its own Claude (Anthropic) account. Your questions, and the project data looked up to answer them, are sent to Anthropic under your organization\'s agreement with them.';
const status=()=>({active:!!saved?.enabled,provider:saved?'anthropic':null,providerName:saved?'Claude (Anthropic)':null,agreed,agreedAt:agreed?now:null,fallbackToPlatform:!!saved?.fallbackToPlatform,notice:saved?notice:null});
const usage={month:'2026-10',creditsUsed:12,creditsLimit:1000,creditsLeft:988,unlimited:false,maxTier:'deep',attachments:true,actions:true,tiers:['quick','standard','deep'].map((id,i)=>({id,label:id,model:'synthetic',credits:i+1,allowed:true,description:'Preview mode'})),attachmentTypes:[],maxFiles:3,maxImageMb:2,maxDocumentMb:2,requestLimits:{perMinute:20,perHour:300,perDay:1500}};
const answerMsg={id:'m2',role:'assistant',content:'Two tasks are late in Atlas.',reasoning:null,tier:'standard',model:'claude-sonnet-5-5',routeReason:'Needs project data',credits:0,status:'complete',tools:[],actions:[],attachments:[],createdAt:now};
const sse=(evs)=>evs.map(([n,d])=>`event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join('');
const writes=[],errors=[],checks=[],asks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
 await ctx.addInitScript(()=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme','light');localStorage.setItem('pm_home_mode','classic');});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
  if(url.origin!==origin||ep.startsWith('/hubs/')){await route.abort();return;}
  if(ep.endsWith('/avatar')||ep.endsWith('/logo/file')){await route.fulfill({status:404,body:''});return;}
  if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
  const body=()=>{try{return req.postDataJSON();}catch{return null;}};
  const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(status<300?{data}:data)});
  if(method!=='GET'&&!ep.endsWith('/auth/refresh')&&ep!=='/api/v1/me/ui/sidebar'&&!ep.endsWith('/read')&&!ep.endsWith('/presence')){
   writes.push({ep,method,b:body()});
   if(ep==='/api/v1/workspace/ai-provider/check'){
    const k=body().apiKey??'';
    return json(k.startsWith('sk-ant-good')?{ok:true,models:MODELS,error:null}:{ok:false,models:[],error:'Anthropic refused this key. Check that it is copied in full and has not been revoked.'});
   }
   if(ep==='/api/v1/workspace/ai-provider'&&method==='PUT'){const b=body();assert.equal(b.apiKey,GOOD);saved=b;return json(settings());}
   if(ep==='/api/v1/workspace/ai-provider'&&method==='DELETE'){saved=null;agreed=false;return route.fulfill({status:204,body:''});}
   if(ep==='/api/v1/ai/provider-consent'&&method==='POST'){agreed=true;return json(status());}
   if(ep==='/api/v1/ai/provider-consent'&&method==='DELETE'){agreed=false;return json(status());}
   if(ep==='/api/v1/ai/ask'){
    asks.push(body().text);
    if(saved?.enabled&&!agreed)return json({message:notice,errors:[{code:'AI_PROVIDER_CONSENT',message:'Agree first to send questions to your organization\'s own Claude (Anthropic) account.'}]},409);
    return route.fulfill({status:200,headers:{'content-type':'text/event-stream'},body:sse([
     ['started',{conversationId:'c-own',questionId:'m1',title:'Late in Atlas'}],
     ['route',{tier:'standard',model:'claude-sonnet-5-5',reason:'Needs project data',limited:false,wanted:'standard',credits:0}],
     ['text',{delta:'Two tasks are late in Atlas.'}],
     ['done',{message:answerMsg,creditsLeft:988,unlimited:true}]])});
   }
   assert.fail(`Unexpected write: ${method} ${ep}`);
  }
  let data=[];
  if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
  else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
  else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:perms,modules:{projects:3,tasks:3,work:3,ai:3,activity:3,documents:3,members:3,organization:3,audit:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
  else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
  else if(ep==='/api/v1/workspace/ai-provider')data=settings();
  else if(ep==='/api/v1/ai/provider-status')data=status();
  else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true,model:'synthetic',provider:'Anthropic'};
  else if(ep.endsWith('/ai/usage'))data=usage;
  else if(ep==='/api/v1/ai/usage/report')data={month:'2026-10',creditsUsed:12,creditsLimit:1000,unlimited:false,answers:6,failed:0,byTier:[],people:[],features:[]};
  else if(ep==='/api/v1/ai/credits/balance')data={spent:12,reserved:0,available:988,unlimited:false};
  else if(ep==='/api/v1/ai/credits/budgets')data=[];
  else if(ep.endsWith('/ai/starters'))data={greeting:'Good morning',starters:[]};
  else if(ep==='/api/v1/ai/conversations/c-own')data={id:'c-own',title:'Late in Atlas',messages:[{id:'m1',role:'user',content:asks.at(-1)??'',reasoning:null,tier:null,model:null,routeReason:null,credits:0,status:'complete',tools:[],actions:[],attachments:[],createdAt:now},answerMsg]};
  else if(ep==='/api/v1/ai/profile')data={notes:'',learned:[],updatedAt:null};
  else if(ep==='/api/v1/ai/instructions')data={text:'',updatedAt:null,updatedBy:null,canEdit:true};
  else if(ep==='/api/v1/settings/changes')data={items:[],canUndo:true};
  else if(ep==='/api/v1/settings/changes/recent')data={items:[],canUndo:true};
  else if(ep==='/api/v1/settings/health')data={score:100,done:1,total:1,open:0,checks:[]};
  else if(ep==='/api/v1/workspace/logo')data={hasLogo:false};
  else if(ep==='/api/v1/notifications/counts')data={unread:0,needsYou:0,forInfo:0,snoozed:0};
  else if(ep==='/api/v1/notifications')data={items:[],page:1,pageSize:20,totalPages:0,totalItems:0};
  else if(ep==='/api/v1/timer')data=null;
  else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
  else if(ep==='/api/v1/chat/projects/unread')data=[];
  else if(ep==='/api/v1/agent/command-center')data={greeting:'Good morning',headline:'Nothing urgent.',since:now,counts:{attention:0,toDecide:0,dueToday:0,overdue:0,blocking:0,checkIns:0,meetingsToday:0,atRisk:0},attention:[],today:[],changes:[],health:[],reliability:{kept:0,missed:0,open:0,moved:0},checkIns:[],owe:[],delegations:[]};
  else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
  else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
  await json(data);
 });
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(250);await page.screenshot({path:path.join(out,name)});};
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&process.env.DEBUG_UI)console.error('console:',m.text().slice(0,600));});await page.setViewportSize({width:1440,height:960});
 try{
  // 1. Settings › Assistant: nothing saved until the provider accepts the key.
  await page.goto(origin+'/preview-org/settings/ai');
  const card=page.getByTestId('own-ai-key');await card.waitFor();
  assert.ok(await card.getByText('Use your own Claude or ChatGPT').isVisible());
  assert.ok(await card.getByRole('radio',{name:/ChatGPT \(OpenAI\)/}).isVisible(),'both providers offered');
  const save=card.getByTestId('own-key-save'), checkBtn=card.getByTestId('own-key-check'), keyBox=card.locator('#own-key-input');
  assert.equal(await keyBox.getAttribute('type'),'password','the key is typed into a password box');
  assert.ok(await save.isDisabled(),'Save waits for a checked key');
  await keyBox.fill(BAD);await checkBtn.click();
  await card.getByRole('alert').filter({hasText:'refused this key'}).waitFor();
  assert.ok(await save.isDisabled(),'a refused key cannot be saved');
  checks.push('refused-key-is-said-plainly-and-not-saveable');
  await keyBox.fill(GOOD);await checkBtn.click();
  await card.getByText('Accepted. 3 models available to this key.').waitFor();
  assert.equal(await card.locator('#own-key-quick').inputValue(),'claude-haiku-5-5');
  assert.equal(await card.locator('#own-key-standard').inputValue(),'claude-sonnet-5-5');
  assert.equal(await card.locator('#own-key-deep').inputValue(),'claude-opus-5-5');
  checks.push('accepted-key-suggests-haiku-sonnet-opus');
  await shot(page,'admin-checked.png');
  await card.getByText('If the key cannot answer, use Project Tracker\'s AI').click();   // off: people see what went wrong instead
  await save.click();
  await card.locator('.own-key-state').getByText(/key ending/).waitFor();
  const put=writes.find(w=>w.method==='PUT'&&w.ep==='/api/v1/workspace/ai-provider');
  assert.deepEqual({q:put.b.quickModel,s:put.b.standardModel,d:put.b.deepModel,on:put.b.enabled,fb:put.b.fallbackToPlatform},{q:'claude-haiku-5-5',s:'claude-sonnet-5-5',d:'claude-opus-5-5',on:true,fb:false});
  assert.equal(await keyBox.inputValue(),'','the box is emptied after saving');
  assert.ok(!(await page.content()).includes(GOOD),'the key is never shown again');
  assert.ok(await card.locator('.own-key-state code').getByText('cdef').isVisible());
  assert.ok(await card.locator('label[for="own-key-input"]').filter({hasText:'leave empty to keep the key ending cdef'}).isVisible());
  assert.ok(!(await save.isDisabled()),'models can be changed without typing the key again');
  checks.push('saved-key-shows-only-its-last-four');
  await shot(page,'admin-saved.png');
  // Settings search finds it.
  await page.goto(origin+'/preview-org/settings');
  const search=page.getByRole('combobox',{name:'Find a setting'}).last();await search.waitFor();await search.fill('chatgpt key');
  await page.getByRole('listbox',{name:'Settings found'}).getByRole('option').first().getByText('Use your own Claude or ChatGPT key').waitFor();
  await search.press('Enter');await page.waitForURL(/\/settings\/ai#s-ai\.ownKey$/);
  await page.waitForFunction(()=>document.querySelector('[data-setting="ai.ownKey"]')?.classList.contains('setting-flash'));
  checks.push('settings-search-finds-own-key');

  // 2. The assistant: a quiet notice first; the first question is held, the person agrees once, and the same question is sent.
  await page.goto(origin+'/preview-org/ai');
  const note=page.getByTestId('provider-notice');await note.waitFor();
  assert.ok(await note.getByText('Claude (Anthropic)').isVisible());
  await shot(page,'assistant-notice.png');
  checks.push('notice-above-the-box-before-agreeing');
  const box=page.locator('.ai-composer :is(textarea,[contenteditable="true"])').first();
  await box.fill('What is late in Atlas?');await box.press('Enter');
  const dlg=page.getByTestId('provider-consent');await dlg.waitFor();
  assert.ok(await dlg.getByText(/sent to Anthropic/).isVisible(),'the notice says where questions go');
  assert.equal(await box.inputValue(),'What is late in Atlas?','the question waits in the box, nothing lost');
  assert.equal(asks.length,1);
  await shot(page,'assistant-consent.png');
  checks.push('first-question-held-and-consent-asked');
  // "Not now" sends nothing.
  await page.getByRole('button',{name:'Not now'}).click();await dlg.waitFor({state:'hidden'});
  assert.equal(writes.filter(w=>w.ep==='/api/v1/ai/provider-consent').length,0);
  await box.press('Enter');await dlg.waitFor();
  await page.getByTestId('provider-agree').click();
  await page.getByText('Two tasks are late in Atlas.').first().waitFor();
  assert.deepEqual(asks,['What is late in Atlas?','What is late in Atlas?','What is late in Atlas?'],'the held question is sent after agreeing');
  await note.waitFor({state:'hidden'});
  assert.equal(await page.getByTestId('provider-consent').count(),0);
  checks.push('agreeing-sends-the-same-question-and-hides-the-notice');
  await shot(page,'assistant-answered.png');

  // 3. Settings › Profile › Assistant (was My account): the person sees what they agreed to and can withdraw.
  await page.goto(origin+'/preview-org/settings/profile/assistant');
  const mine=page.getByTestId('my-ai-provider');await mine.waitFor();
  assert.ok(await mine.getByText(/You agreed on/).isVisible());
  await mine.getByRole('button',{name:'Withdraw'}).click();
  await mine.getByText(/You have not agreed/).waitFor();
  assert.ok(writes.some(w=>w.ep==='/api/v1/ai/provider-consent'&&w.method==='DELETE'));
  checks.push('withdraw-in-my-account');

  // 4. A phone: the card and the dialog fit.
  await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/preview-org/settings/ai');await page.getByTestId('own-ai-key').waitFor();
  await page.getByTestId('own-ai-key').scrollIntoViewIfNeeded();
  await fitsPhone(page,'own key card',assert);await shot(page,'phone-card.png');
  await page.goto(origin+'/preview-org/ai');await page.getByTestId('provider-notice').waitFor();
  await fitsPhone(page,'assistant notice',assert);
  await page.getByTestId('provider-notice').getByRole('button',{name:'Review and agree'}).click();
  await page.getByTestId('provider-consent').waitFor();await fitsPhone(page,'consent dialog',assert);await shot(page,'phone-consent.png');
  const before=asks.length;
  await page.getByTestId('provider-agree').click();await page.getByTestId('provider-consent').waitFor({state:'hidden'});
  assert.equal(asks.length,before,'agreeing from the notice sends nothing by itself');
  checks.push('phone-card-notice-and-dialog-fit');
 }catch(e){await page.screenshot({path:path.join(out,"failure.png")}).catch(()=>{});console.error("page errors:",errors);throw e;}
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify({fixture:'Synthetic APIs only; no provider, model or real key',checks,pageErrors:errors},null,2));
 console.log(JSON.stringify({checks,pageErrors:errors,artifacts:out}));
}finally{await browser.close();}
