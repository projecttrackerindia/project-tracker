import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Weekly report page (design s-report): source line, health + verdict, four numbers, sourced sections, send card (recipients, Mail /
// Messages / PDF, Approve & send), the Friday reminder, tone rewrites and the last 4 weeks - light, dark and phone.
// Built frontend with synthetic API fixtures only.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/weekly-report-ui');
await fs.mkdir(out,{recursive:true});
const csp = await appCsp();
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const R=(id,title,state,extra)=>({id,source:'Personal',state,title,note:null,targetType:'None',targetId:null,targetKey:null,targetTitle:null,link:null,timeZone:'Asia/Kolkata',localAt:null,anchorDays:null,anchorTime:null,recurrence:null,recurrenceText:null,onlyIfOpen:false,exact:false,nextFireAt:null,isSnoozed:false,snoozeCount:0,fireCount:0,lastFiredAt:null,quiet:false,completedAt:null,seriesId:null,from:null,for:null,canEdit:true,createdAt:iso(-600),...extra});

const P='00000000-0000-0000-0000-0000000000a1',U2='00000000-0000-0000-0000-0000000000b2',U3='00000000-0000-0000-0000-0000000000c3';
const it=(text,owner,source,link,external=false)=>({text,owner,source,link,external});
const weekly={projectId:P,projectName:'Payments Hub',from:'2026-10-20',to:'2026-10-26',health:'At risk',text:'**Payments Hub — week of 20 Oct to 26 Oct**\n\n**What moved**\n- PH-212 UPI collect flow',moved:11,slipped:3,risks:2,next:2,canSend:true,
 projectKey:'PH',week:43,verdict:'8 Nov is still possible if 2 blocked items move this week.',sources:{updates:64,meetings:3,commits:41},scopeChange:6,progress:72,forecastDays:4,forecastDate:'2026-11-08',
 movedItems:[it('UPI collect flow passed QA','Sara Iyer','PH-212',`/projects/${P}?task=t1`),it('Refund API merged','Leo Park','a1b2c3d','https://github.example/pr/388',true)],
 slippedItems:[it('Bank gateway certification moved 3 days — sandbox was down','Ruth Mensah','PH-201',`/projects/${P}?task=t2`)],
 riskItems:[it('Retry queue is waiting on PH-201','Lena Ford','PH-230',`/projects/${P}?task=t3`),it('Pen-test is 2 days overdue',null,'PH-240',`/projects/${P}?task=t4`)],
 nextItems:[it('Cutover rehearsal · due 1 Nov','Sara Iyer','PH-250',`/projects/${P}?task=t5`)],
 people:[{id:user.id,name:'Asha Rao'},{id:U2,name:'Daniel Okafor'},{id:U3,name:'Tomás Rivera'}],
 history:[{sentAt:'2026-10-24T11:30:00Z',by:'Asha Rao',health:'At risk',done:9,slipped:1,channels:['chat']},{sentAt:'2026-10-17T11:30:00Z',by:'Asha Rao',health:'At risk',done:8,slipped:2,channels:['mail']},{sentAt:'2026-10-10T11:30:00Z',by:'Asha Rao',health:'On track',done:7,slipped:0,channels:['chat']},{sentAt:'2026-10-03T11:30:00Z',by:'Asha Rao',health:'On track',done:12,slipped:0,channels:['chat']}],
 schedule:null,writtenAt:new Date(now-120000).toISOString()};
let scheduled=null;
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async(theme,mailLinked=false)=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  if(mailLinked)await ctx.addInitScript(([k,v])=>localStorage.setItem(k,v),[`pt.mail.${ws.id}.${user.id}`,JSON.stringify({projects:{'imap:m1|inbox|msg1':P}})]);
  await ctx.addInitScript((t)=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme',t);localStorage.setItem('pm_home_mode','classic');window.print=()=>{window.__printed=(window.__printed||0)+1;};},theme);
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[];
   const W=`/api/v1/project-status/projects/${P}/weekly`;
   if(ep===W+'/send'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data={sent:true};}
   else if(ep===W+'/schedule'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});scheduled={reminderId:'r1',nextAt:'2026-10-30T11:30:00Z',timeZone:'Asia/Kolkata'};data=scheduled;}
   else if(ep===W+'/schedule'&&method==='DELETE'){writes.push({ep});scheduled=null;data={scheduled:false};}
   else if(ep==='/api/v1/chat/ai/transform'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={text:`(${b.action}) Payments Hub is at risk.`,blocks:null,model:'test'};}
   else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','tasks.view','org.manage','reports.view','work.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
    else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
    else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
    else if(ep===W)data={...weekly,schedule:scheduled};
    else if(ep===`/api/v1/projects/${P}`)data={project:{id:P,key:'PH',name:'Payments Hub',status:'Active',health:'AtRisk'},members:[],stages:[]};
    else if(ep.endsWith('/projects')||ep.endsWith('/tasks')||ep.endsWith('/work-tasks'))data={items:[],page:1,totalPages:0,totalItems:0};
    else if(ep==='/api/v1/me/mailbox/accounts')data={imap:[{id:'m1',name:'Work mail',email:'asha@fictive.test',lastError:null}],presets:[],company:null,canManageCompany:false,myEmail:null};
    else if(ep==='/api/v1/me/mailbox/messages'){const f=url.searchParams.get('folder');data={account:'imap:m1',email:'asha@fictive.test',folder:f,cursor:null,messages:f==='inbox'?[
      {id:'msg1',threadId:'th1',subject:'Bank sandbox down again',from:'Ruth Mensah <ruth@bank.fictive.test>',to:'asha@fictive.test',cc:'',date:'2026-10-23T09:00:00Z',unread:false,hasAttachments:false},
      {id:'msg2',threadId:'th1',subject:'Re: Bank sandbox down again',from:'Ruth Mensah <ruth@bank.fictive.test>',to:'asha@fictive.test',cc:'',date:'2026-10-24T09:00:00Z',unread:true,hasAttachments:false},
      {id:'msg3',threadId:'th9',subject:'Lunch on Friday',from:'Leo Park <leo@fictive.test>',to:'asha@fictive.test',cc:'',date:'2026-10-24T10:00:00Z',unread:true,hasAttachments:false}]:[]};}
    else if(ep==='/api/v1/timer')data=null;
    else if(ep.endsWith('/me/fingerprint'))data={fingerprint:'preview'};
    else if(ep.endsWith('/ai/status'))data={enabled:true,configured:true,entitled:true,allowedHere:true};
    else if(ep.endsWith('/workspace/logo'))data={hasLogo:false};
    else if(ep==='/api/v1/notifications')data={items:[],page:1,pageSize:20,totalPages:0,totalItems:0};
    else if(ep.includes('/counts')||ep.includes('/unread'))data={count:0,total:0};
   }
   await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
  });
  return ctx;};
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);await page.screenshot({path:path.join(out,name),fullPage:true});};
 const url=origin+`/preview-org/work/projects/${P}/report`;

 let ctx=await make('light');let page=await ctx.newPage();page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text().slice(0,3000));});page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(url);await page.locator('.wrp-doc').waitFor({timeout:8000}).catch(async()=>{await page.screenshot({path:path.join(out,'fail.png')});console.log(errors,(await page.locator('body').innerText()).slice(0,600));throw new Error('no doc');});
 assert.equal(await page.locator('.wrp-h1').innerText(),'Week 43 report');
 assert.match(await page.locator('.wrp-eyebrow').innerText(),/weekly status · 20 – 26 oct/i);
 assert.match(await page.locator('.wrp-sourceline').innerText(),/Written from 64 updates, 3 meetings and 41 commits · 2 min ago/);
 assert.match(await page.locator('.wrp-pill').first().innerText(),/At risk/);
 assert.deepEqual(await page.locator('.wrp-kpi span').allInnerTexts(),['Items done','Slipped','Scope change · 72% done','Forecast vs plan · 8 Nov']);
 assert.deepEqual(await page.locator('.wrp-kpi b').allInnerTexts(),['11','3','+6%','+4d']);
 assert.deepEqual((await page.locator('.wrp-sec h4').allInnerTexts()).map(s=>s.toLowerCase()),['what moved','what slipped, and why','risks','next week']);
 assert.equal(await page.locator('.wrp-sec a.wrp-src[href*="?task=t1"]').count(),1,'items link to their source task');
 assert.equal(await page.locator('.wrp-sec a.wrp-src[target=_blank]').getAttribute('href'),'https://github.example/pr/388');
 assert.match(await page.locator('.wrp-sec.risks li').nth(1).innerText(),/Owner: unassigned/);
 assert.deepEqual(await page.locator('.wrp-weeks .wrp-pill').allInnerTexts(),['W40','W41','W42','W43']);
 checks.push('layout');
 await shot(page,'weekly-light-1440.png');

 // Recipients: add a person (switches Mail on), then Approve & send to chat + mail.
 await page.getByRole('button',{name:'＋ Add person or channel'}).click();
 await page.getByLabel('Add person or channel').selectOption(U2);
 assert.equal(await page.getByRole('button',{name:'Mail'}).getAttribute('aria-pressed'),'true');
 await page.locator('.wrp-approve-side').click();
 await page.waitForFunction(()=>true);await page.waitForTimeout(300);
 const sent=writes.find(w=>w.ep.endsWith('/send'));assert.ok(sent);assert.equal(sent.b.chat,true);assert.equal(sent.b.mail,true);assert.deepEqual(sent.b.recipients,[U2]);
 checks.push('send');
 // PDF only: prints, no send.
 await page.getByRole('button',{name:'Mail'}).click();await page.getByRole('button',{name:'Messages'}).click();await page.getByRole('button',{name:'PDF'}).click();
 const before=writes.length;await page.locator('.wrp-approve-side').click();await page.waitForTimeout(300);
 assert.equal(writes.length,before);assert.equal(await page.evaluate(()=>window.__printed),1);checks.push('pdf');
 // Friday reminder.
 await page.getByRole('button',{name:/Every Friday 5 PM/}).click();await page.locator('.wrp-sched.on').waitFor();
 assert.match(writes.find(w=>w.ep.endsWith('/schedule')).b.timeZone,/^Asia\/(Kolkata|Calcutta)$/);checks.push('schedule');
 // Tone.
 await page.getByRole('button',{name:'For execs'}).click();await page.locator('.wrp-edit textarea').waitFor();
 assert.equal(await page.locator('.wrp-edit textarea').inputValue(),'(formal) Payments Hub is at risk.');
 assert.equal(writes.find(w=>w.ep.endsWith('/transform')).b.action,'formal');checks.push('tone');
 await shot(page,'weekly-light-1440-edit.png');
 await ctx.close();

 // Mail as a source: a thread linked to this project in Mail is counted in the source line and cited with its sender.
 ctx=await make('light',true);page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 scheduled=null;await page.goto(url);await page.getByTestId('report-mail').waitFor();
 assert.match(await page.locator('.wrp-sourceline').innerText(),/Written from 64 updates, 3 meetings, 2 mails and 41 commits/);
 assert.equal(await page.getByTestId('report-mail').locator('li').count(),1,'only the linked thread');
 assert.match(await page.getByTestId('report-mail').locator('li').innerText(),/Bank sandbox down again/);
 await page.getByTestId('report-mail').locator('a.wrp-src',{hasText:'Mail · Ruth'}).waitFor();
 await shot(page,'weekly-mail-1440.png');checks.push('mail-source');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);await fitsPhone(page,'weekly with mail',assert);await shot(page,'weekly-mail-390.png');
 await ctx.close();

 ctx=await make('dark');page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 scheduled=null;await page.goto(url);await page.locator('.wrp-doc').waitFor();await shot(page,'weekly-dark-1440.png');checks.push('dark');await ctx.close();

 for(const theme of ['light','dark']){
  ctx=await make(theme);page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
  await page.goto(url);await page.locator('.wrp-doc').waitFor();
  await fitsPhone(page,`weekly ${theme}`,assert);
  assert.ok(await page.locator('.wrp-approve-side').isVisible(),'phone: Approve & send sits in the send sheet');assert.ok(!(await page.locator('.wrp-approve-top').isVisible()));
  await shot(page,`weekly-${theme}-390.png`);checks.push(`phone-${theme}`);await ctx.close();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,writes:writes.length,errors}));
} finally { await browser.close(); }
