import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Mailbox: accounts rail, unified inbox, reading, the mail agent (summary, task suggestions, reply drafts), reply all and connecting
// Rediffmail. Built frontend with synthetic API fixtures only; mail content must render as literal text.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/mailbox-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const pid='00000000-0000-0000-0000-000000000003';
const now=Date.now(),iso=(m)=>new Date(now+m*60000).toISOString();
const W=(n,title,status,priority,assignee,sla,type='Production Support')=>({id:`w${n}`,key:`WT-${n}`,number:n,title,description:null,workTypeId:'t1',workType:type,relatedProject:null,assignee:assignee?{id:assignee[0],name:assignee[1]}:null,reporter:{id:user.id,name:user.displayName},priority,status,startDate:null,dueDate:null,isOverdue:false,completedAt:status==='Completed'?iso(-600):null,createdAt:iso(-3000),version:1,commentCount:0,attachmentCount:0,can:{edit:true,delete:true},loggedMinutes:0,sla:sla?{response:null,resolution:{dueAt:iso(sla==='Breached'?-60:120),metAt:null,state:sla},state:sla}:null});
const M=(id,from,subject,mins,unread,body,extra={})=>({id,threadId:id,subject,from,to:'Asha Rao <asha@example.test>',cc:'',date:iso(-mins),unread,hasAttachments:false,body,bodyTruncated:false,...extra});
const gmail=[M('a1','Ravi Kumar <ravi@client.test>','Portal login fix — can you confirm by Friday?',12,true,'Hi Asha,\n\nThe customer portal login bug is blocking our team. Can you confirm the fix will ship by Friday 23 October?\n\n<script>window.mailUnsafe=1</script>\n\nThanks,\nRavi',{cc:'Meena <meena@client.test>'}),
 M('a2','Payroll <noreply@pay.test>','Your payslip for October',300,false,'Your payslip is ready.')];
const rediff=[M('101','Kiran <kiran@rediffmail.com>','Invoice 4471 approved',90,true,'Asha, the invoice 4471 is approved. Please close the billing task.')];
const writes=[],errors=[],checks=[];
let imap=[{id:'00000000-0000-0000-0000-0000000000aa',provider:'rediff',name:'Rediffmail',email:'asha@rediffmail.com',connectedAt:iso(-9000),lastSyncedAt:iso(-5),lastError:null}];
const presets=[{id:'rediff',name:'Rediffmail',imapHost:'imap.rediffmail.com',imapPort:993,smtpHost:'smtp.rediffmail.com',smtpPort:465,domain:'rediffmail.com'},{id:'rediffpro',name:'Rediffmail Pro',imapHost:'',imapPort:993,smtpHost:'',smtpPort:465,domain:''}];
const assist={summary:'Ravi needs confirmation that the customer portal login fix ships by Friday 23 October; his team is blocked.',intent:'action_required',urgency:'high',keyFacts:['Deadline: Friday 23 October'],actionItems:['Confirm the release date to Ravi'],
 replies:[{label:'Confirm Friday',body:'Hi Ravi,\n\nYes - the login fix ships on Friday 23 October.\n\nAsha'},{label:'Ask for details',body:'Hi Ravi,\n\nCould you share the error your team sees?\n\nAsha'}],
 tasks:[{kind:'update',taskId:'w2',taskKind:'work',taskRef:'W-2',projectId:null,title:'Fix customer portal login',detail:'Client asked for Friday delivery.',priority:null,status:'InProgress',reason:'confirm the fix will ship by Friday',due:null},
  {kind:'create',taskId:null,taskKind:'work',taskRef:null,projectId:null,title:'Reply to Ravi about the portal release',detail:'Confirm the date.',priority:'High',status:null,reason:'Can you confirm',due:'2026-10-23'}],model:'test'};
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
   let data=[];
   const p=url.searchParams;
   if(ep==='/api/v1/me/mailbox/send'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={accepted:true,to:'ravi@client.test',cc:b.replyAll?'meena@client.test':'',subject:'Re: Portal login fix'};}
   else if(ep==='/api/v1/me/mailbox/agent/assist'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data=assist;}
   else if(ep==='/api/v1/me/mailbox/agent/compose'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});data={body:b.draft.trim()+'\n\nImproved.',model:'test'};}
   else if(ep==='/api/v1/me/mailbox/accounts/imap'&&method==='POST'){const b=req.postDataJSON();writes.push({ep,b});const a={id:'00000000-0000-0000-0000-0000000000bb',provider:b.provider,name:'Rediffmail Pro',email:b.email,connectedAt:iso(0),lastSyncedAt:iso(0),lastError:null};imap=[...imap,a];data=a;}
   else if(/\/api\/v1\/work-tasks\/w\d+\/status/.test(ep)&&method==='PUT'){writes.push({ep,b:req.postDataJSON()});data={id:'w2'};}
   else if(/\/api\/v1\/work-tasks\/w\d+\/comments/.test(ep)&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data={id:'c1'};}
   else if(ep==='/api/v1/work-tasks'&&method==='POST'){writes.push({ep,b:req.postDataJSON()});data={id:'w9'};}
   else if(ep==='/api/v1/agent/inbox')data={items:[],pending:0,canDecide:true};
   else if(ep==='/api/v1/me/ui/sidebar')data={key:'sidebar',value:null,updatedAt:null};
   else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','tasks.view','tasks.edit','org.manage','reports.view','work.view','work.create','work.edit'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
    else if(ep==='/api/v1/workspace')data={...ws,aiDisabled:false};
    else if(ep==='/api/v1/integrations/google/status')data={connected:true,googleEmail:'asha@example.test',connectedAt:iso(-9000),lastError:null,calendarAccess:true,mailEnabled:true,mailSendAccess:true,inboxEnabled:true,inboxAccess:true};
    else if(ep==='/api/v1/integrations/microsoft/status')data={enabled:true,configured:true,connected:false,email:null,mailSendAccess:false,inboxEnabled:true,inboxAccess:false,calendarsEnabled:true,calendarAccess:false};
    else if(ep==='/api/v1/me/mailbox/accounts')data={imap,presets};
    else if(ep==='/api/v1/me/mailbox/agent/options')data={available:true,credits:1};
    else if(ep==='/api/v1/me/mailbox/messages'){const acc=p.get('account');const list=p.get('folder')==='sent'?[]:acc==='google'?gmail:acc.startsWith('imap:')?rediff:[];data={account:acc,email:acc==='google'?'asha@example.test':'asha@rediffmail.com',folder:p.get('folder'),messages:list.map(({body,...m})=>m),cursor:null};}
    else if(ep==='/api/v1/me/mailbox/thread'){const acc=p.get('account');const m=[...gmail,...rediff].find(x=>x.id===p.get('messageId'));data={account:acc,email:'asha@example.test',folder:'inbox',threadId:m.id,messages:[m],truncated:false};}
    else if(ep==='/api/v1/work-tasks'){const st=url.searchParams.get('status'),open=url.searchParams.get('open');let it=tasks.filter(t=>(!st||t.status===st)&&(open!=='true'||['ToDo','InProgress','OnHold'].includes(t.status)));if(url.searchParams.get('unassigned')==='true')it=it.filter(t=>!t.assignee);if(url.searchParams.get('sla')==='breached')it=it.filter(t=>t.sla?.state==='Breached');data={items:it,page:1,pageSize:25,totalPages:1,totalItems:it.length};}
    else if(ep==='/api/v1/work-types')data=[{id:'t1',name:'Production Support',description:null,order:0,isActive:true,taskCount:3},{id:'t2',name:'Analysis',description:null,order:1,isActive:true,taskCount:1}];
    else if(ep==='/api/v1/workspace/members')data=members;
    else if(ep==='/api/v1/operations/settings')data=settings;
    else if(ep==='/api/v1/operations/insights')data=insights;
    else if(ep==='/api/v1/work/sla')data={entitled:true,canManage:true,defaults:[{priority:'Critical',responseMinutes:30,resolutionMinutes:240},{priority:'High',responseMinutes:120,resolutionMinutes:1440},{priority:'Medium',responseMinutes:480,resolutionMinutes:4320},{priority:'Low',responseMinutes:1440,resolutionMinutes:10080}],overrides:[]};
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
 const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);await page.screenshot({path:path.join(out,name)});};
 const waitWrite=async(test)=>{for(let i=0;i<30&&!writes.some(test);i++)await new Promise(r=>setTimeout(r,100));return writes.find(test);};
 let ctx=await make();let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 await page.goto(origin+'/preview-org/mailbox');await page.locator('.mb-row').first().waitFor();
 // The sidebar offers Mailbox; the unified inbox merges Gmail and Rediffmail, newest first.
 assert.ok(await page.locator('nav a[href$="/mailbox"]').first().isVisible());
 assert.equal(await page.locator('.mb-row').count(),3);
 assert.match(await page.locator('.mb-row').first().innerText(),/Ravi Kumar/);
 assert.match(await page.locator('.mb-row').nth(1).innerText(),/Kiran/);
 assert.ok(await page.locator('.mb-account-head',{hasText:'Rediffmail'}).isVisible());
 assert.ok(await page.locator('.mb-needs').count()===0);checks.push('unified-inbox');
 await page.getByRole('tab',{name:'Unread'}).click();assert.equal(await page.locator('.mb-row').count(),2);await page.getByRole('tab',{name:'All'}).click();
 // Reading renders mail as text, never HTML.
 await page.locator('.mb-row').first().click();await page.locator('.mb-msg-body').waitFor();
 assert.match(await page.locator('.mb-msg-body').innerText(),/<script>/);assert.equal(await page.evaluate(()=>window.mailUnsafe),undefined);
 await shot(page,'read-1440.png');checks.push('read-literal');
 // The agent: summary, task suggestions applied by the person, reply chips into the composer.
 await page.getByRole('button',{name:'Ask agent'}).click();await page.locator('.mb-agent-summary').waitFor();
 assert.match(await page.locator('.mb-agent').innerText(),/Action required/);
 await page.locator('.mb-task',{hasText:'W-2'}).getByRole('button',{name:'Apply update'}).click();
 assert.equal((await waitWrite(w=>w.ep.endsWith('/w2/status'))).b.status,'InProgress');assert.ok(await waitWrite(w=>w.ep.endsWith('/w2/comments')));
 await page.locator('.mb-task',{hasText:'Reply to Ravi'}).getByRole('button',{name:'Create task'}).click();
 const created=await waitWrite(w=>w.ep==='/api/v1/work-tasks');assert.equal(created.b.priority,'High');assert.equal(created.b.dueDate,'2026-10-23');assert.equal(created.b.workTypeId,'t1');
 await shot(page,'agent-1440.png');checks.push('agent-tasks');
 await page.locator('.mb-reply-chips button',{hasText:'Confirm Friday'}).click();
 const box=page.getByLabel('Reply',{exact:true});await box.waitFor();assert.match(await box.inputValue(),/ships on Friday/);
 await page.getByRole('toolbar',{name:'Writing help'}).getByRole('button',{name:'Improve'}).click();
 await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Reply"]')?.value.includes('Improved.'));
 await page.getByRole('button',{name:'Everyone'}).click();
 await page.locator('.mb-compose.inline').getByRole('button',{name:'Send',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Send',exact:true}).click();
 const sent=await waitWrite(w=>w.ep==='/api/v1/me/mailbox/send');
 assert.equal(sent.b.account,'google');assert.equal(sent.b.replyToId,'a1');assert.equal(sent.b.replyAll,true);assert.equal(sent.b.confirmed,true);assert.match(sent.b.body,/> Hi Asha/);
 checks.push('reply-all');
 // Connecting Rediffmail Pro: preset only, never a host.
 await page.getByRole('button',{name:'Connect mail'}).click();
 await page.locator('.mb-provider',{hasText:'Rediffmail Pro'}).click();
 await page.getByLabel('Email address').fill('asha@company.in');await page.locator('.mb-imap input[type=password]').fill('app-password-for-test');
 await shot(page,'connect-1440.png');
 await page.getByRole('dialog').getByRole('button',{name:'Connect',exact:true}).click();
 const con=await waitWrite(w=>w.ep==='/api/v1/me/mailbox/accounts/imap');assert.deepEqual(Object.keys(con.b).sort(),['email','password','provider']);assert.equal(con.b.provider,'rediffpro');
 await page.locator('.mb-account-head',{hasText:'Rediffmail Pro'}).waitFor();checks.push('connect-rediff');
 // New mail with the agent's help.
 await page.getByRole('button',{name:'New mail'}).click();
 await page.getByRole('dialog').locator('.mb-line',{hasText:'To'}).locator('input').fill('team@example.test');
 await page.getByRole('textbox',{name:'Message',exact:true}).fill('Release moved to Friday');
 await page.getByRole('dialog').getByRole('button',{name:'Shorter'}).click();
 await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message"]')?.value.includes('Improved.'));
 await page.getByRole('dialog').getByRole('button',{name:'Discard'}).click();checks.push('compose-agent');
 // Dark theme.
 await page.evaluate(()=>{document.documentElement.setAttribute('data-theme','dark');});await shot(page,'dark-1440.png');
 await page.close();await ctx.close();
 // Phone: one pane at a time, no sideways scroll.
 ctx=await make();page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/preview-org/mailbox');await page.locator('.mb-row').first().waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await shot(page,'list-390.png');
 await page.locator('.mb-row').first().click();await page.locator('.mb-msg-body').waitFor();assert.equal(await page.locator('.mb-list').isVisible(),false);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await shot(page,'read-390.png');
 await page.getByRole('button',{name:'Back to messages'}).click();await page.locator('.mb-row').first().waitFor();checks.push('phone');
 await page.close();await ctx.close();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
