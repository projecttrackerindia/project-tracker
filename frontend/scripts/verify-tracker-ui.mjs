import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff, fitsPhone } from './lib/phone.mjs';

// Agent Tracker against the built frontend and synthetic API fixtures only. No live model, meeting or AI calls.
const origin='https://projecttracker-preview.test', dist=path.resolve('dist'), out=path.resolve('test-results/tracker-ui');
await fs.mkdir(out,{recursive:true});
const csp=(await fs.readFile('nginx.conf','utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user={id:'00000000-0000-0000-0000-000000000001',displayName:'Asha Rao',email:'asha@example.test',emailVerified:true,timeZone:'Asia/Kolkata',isPlatformAdmin:false};
const ws={id:'00000000-0000-0000-0000-000000000002',slug:'preview-org',name:'Preview Workspace',type:'Organization',role:'Owner',planCode:'BUSINESS',memberCount:4};
// A token shaped like the real one (the app reads the workspace from it); without the claim a second refresh looks like a tenant switch and clears the cache.
const token=`x.${Buffer.from(JSON.stringify({wid:ws.id,exp:4102444800})).toString('base64url')}.x`;
const day=86400000, now=Date.parse('2030-01-08T06:00:00Z');
// A deterministic week of runs.
let seed=7; const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
const intents=['task_lookup','risk_analysis','schedule_meeting','workload','reasoning'];
const statuses=['succeeded','succeeded','succeeded','succeeded','succeeded','partial','awaiting_confirmation','failed','timeout'];
const runs=Array.from({length:60},(_,i)=>{const st=statuses[Math.floor(rnd()*statuses.length)];const dur=Math.round(600+rnd()*rnd()*24000);const at=new Date(now-rnd()*7*day).toISOString();
  return {id:`r${i}`,createdAt:at,status:st,inputTokens:Math.round(800+rnd()*4000),outputTokens:Math.round(100+rnd()*800),feedback:rnd()>.8?'up':rnd()>.93?'down':null,
   trace:{agent:'project-assistant',version:'2',correlationId:`c-${i}`,provider:'Anthropic',model:i%3?'claude-haiku-5-5':'claude-sonnet-5-5',startedAt:at,durationMs:dur,contextMs:Math.round(dur*.08),firstTokenMs:Math.round(dur*.3),
    promptChars:12000,toolDefinitions:18,outcome:st,errorCode:st==='failed'?'tool_failed':st==='timeout'?'AI_TIMEOUT':null,intent:intents[i%5],intentMs:40,
    models:[{step:0,durationMs:Math.round(dur*.45),inputTokens:900,outputTokens:120,stopReason:'tool_use'},{step:1,durationMs:Math.round(dur*.2),inputTokens:1400,outputTokens:300,stopReason:'end_turn'}],
    tools:[{name:'find_work',durationMs:Math.round(dur*.12),succeeded:st!=='failed',state:'read'},{name:'workload_balance',durationMs:Math.round(dur*.06),succeeded:true,state:'read'}],
    database:{commands:14,durationMs:22.5,failedCommands:0},actions:st==='awaiting_confirmation'?[{id:'a1',kind:'update_task',status:'awaiting_confirmation',durationMs:null,confirmationWaitMs:null,attempts:1}]:[]}}});
const days7=Array.from({length:8},(_,i)=>new Date(now-(7-i)*day));
const timeline=days7.map((d)=>{const at=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));const inb=runs.filter(r=>{const t=Date.parse(r.createdAt);return t>=+at&&t<+at+day;});
  const ds=inb.map(r=>r.trace.durationMs).sort((a,b)=>a-b);const p=(q)=>ds.length?ds[Math.max(0,Math.ceil(ds.length*q)-1)]:0;
  return {at:at.toISOString(),succeeded:inb.filter(r=>r.status==='succeeded').length,failed:inb.filter(r=>['failed','timeout'].includes(r.status)).length,partial:inb.filter(r=>r.status==='partial').length,awaiting:inb.filter(r=>r.status==='awaiting_confirmation').length,p50Ms:p(.5),p95Ms:p(.95)};});
const buckets=[['< 1s',1000],['1-2s',2000],['2-5s',5000],['5-10s',10000],['10-20s',20000],['20-40s',40000],['40s+',-1]];
let lo=-1;const latency=buckets.map(([label,up])=>{const hi=up<0?Infinity:up;const c=runs.filter(r=>r.trace.durationMs>lo&&r.trace.durationMs<=hi).length;lo=hi;return {label,upToMs:up,count:c};});
const tracker={agent:{id:'project-assistant',name:'Project Assistant',version:'2',enabled:true,provider:'Anthropic',model:'claude-sonnet-5-5',capabilities:['project and task retrieval','workload and risk analysis','confirmation-based actions','meeting scheduling'],maxToolCalls:8,timeoutSeconds:60},
 total:runs.length,succeeded:runs.filter(r=>r.status==='succeeded').length,failed:runs.filter(r=>['failed','timeout'].includes(r.status)).length,partial:runs.filter(r=>r.status==='partial').length,awaitingConfirmation:runs.filter(r=>r.status==='awaiting_confirmation').length,
 averageMs:5200,p95Ms:17800,p50Ms:3100,modelCalls:120,databaseCommands:840,inputTokens:runs.reduce((a,r)=>a+r.inputTokens,0),outputTokens:runs.reduce((a,r)=>a+r.outputTokens,0),sampleLimited:false,page:1,pageSize:25,runs:runs.slice(0,25),
 slowestPaths:[{intent:'risk_analysis',requests:12,failures:3,p50Ms:6100,p95Ms:21800,averageQueueMs:120,averageModelMs:4300,averageToolMs:900},{intent:'reasoning',requests:12,failures:2,p50Ms:4100,p95Ms:15400,averageQueueMs:null,averageModelMs:3100,averageToolMs:400},{intent:'workload',requests:12,failures:1,p50Ms:2200,p95Ms:9100,averageQueueMs:null,averageModelMs:1800,averageToolMs:500},{intent:'task_lookup',requests:12,failures:0,p50Ms:1100,p95Ms:3800,averageQueueMs:null,averageModelMs:800,averageToolMs:200}],
 frequentErrors:[{code:'AI_TIMEOUT',count:4},{code:'tool_failed',count:3},{code:'action_failed',count:1}],
 insights:{timeline,bucketUnit:'day',latency,phases:{contextMs:410,routingMs:40,modelMs:3300,toolMs:950,otherMs:500},
  tools:[{name:'find_work',calls:60,failures:5,averageMs:620},{name:'workload_balance',calls:60,failures:0,averageMs:310},{name:'portfolio_brief',calls:14,failures:1,averageMs:1450},{name:'schedule_meeting',calls:9,failures:0,averageMs:880}],
  models:[{model:'claude-haiku-5-5',runs:40,averageMs:3400,inputTokens:96000,outputTokens:18000},{model:'claude-sonnet-5-5',runs:20,averageMs:8800,inputTokens:71000,outputTokens:16500}],
  feedbackUp:11,feedbackDown:2,cacheReadTokens:54000,firstTokenP50Ms:900,actions:[{kind:'update_task',count:6,failed:1,confirmed:5},{kind:'schedule_meeting',count:3,failed:0,confirmed:3}]}};
const pid='00000000-0000-0000-0000-000000000003';
const fleet={from:new Date(now-7*day).toISOString(),to:new Date(now).toISOString(),
 projectAgent:{projectsOn:4,readings:38,failedReadings:1,findings:142,approved:96,autoApplied:21,dismissed:27,pending:19,credits:184,averageDecisionHours:5.4,
  kinds:[{kind:'CreateTask',found:41,approved:30,dismissed:6,pending:5,auto:4},{kind:'CreateActionItem',found:33,approved:26,dismissed:3,pending:4,auto:12},{kind:'UpdateTask',found:22,approved:15,dismissed:4,pending:3,auto:0},{kind:'Delay',found:14,approved:8,dismissed:4,pending:2,auto:0},{kind:'Decision',found:17,approved:13,dismissed:2,pending:2,auto:5},{kind:'Missed',found:9,approved:4,dismissed:4,pending:1,auto:0},{kind:'Suggestion',found:6,approved:0,dismissed:4,pending:2,auto:0}],
  sources:[{source:'LiveMeeting',signals:21},{source:'ProjectMailbox',signals:17},{source:'Chat',signals:12},{source:'MeetingTranscript',signals:6},{source:'Slack',signals:4}],atLevel1:0,atLevel2:2,atLevel3:1,atLevel4:1},
 meetings:{sessions:24,attended:21,failed:2,meetTranscripts:6,minutesSent:18,delegations:5,delegationsReported:4,captionLines:0},
 followUps:{commitments:46,kept:31,missed:5,moved:4,open:6,checkInsSent:28,answered:24,changeRequests:6},
 days:days7.map((d,i)=>({day:d.toISOString().slice(0,10),readings:3+(i*7)%5,findings:12+(i*11)%14,decided:9+(i*5)%12,meetings:2+(i*3)%4})),
 projects:[{projectId:pid,key:'PAY',name:'Payments Core',level:4,readings:16,findings:64,approved:44,dismissed:9,pending:11},{projectId:'p2',key:'WEB',name:'Website relaunch',level:2,readings:12,findings:46,approved:31,dismissed:11,pending:4},{projectId:'p3',key:'MOB',name:'Mobile app',level:3,readings:10,findings:32,approved:21,dismissed:7,pending:4}]};
fleet.dismissReasons=[{reason:'duplicate',count:9},{reason:'not_needed',count:7},{reason:'wrong',count:5},{reason:'unspecified',count:6}];
const costDays=Array.from({length:14},(_,i)=>({day:new Date(now-(13-i)*day).toISOString().slice(0,10),assistant:20+(i*7)%15,agent:12+(i*5)%18,meetings:(i*3)%5,other:i%4}));
const cost={month:'2030-01',limit:1000,spent:640,reserved:12,available:348,unlimited:false,dailyAverage:58,daysLeft:6,runsOutOn:'2030-01-14',runsOutBeforeReset:true,resetsOn:'2030-02-01',
 features:[{group:'assistant',label:'Project Assistant',credits:330},{group:'agent',label:'Project agent',credits:260},{group:'meetings',label:'Meeting bot (live reminders)',credits:30},{group:'other',label:'Mail',credits:20}],
 days:costDays,projects:[{projectId:pid,key:'PAY',name:'Payments Core',credits:150,cap:160,readings:16},{projectId:'p2',key:'WEB',name:'Website relaunch',credits:80,cap:0,readings:12},{projectId:'p3',key:'MOB',name:'Mobile app',credits:30,cap:100,readings:10}]};
let alertSettings={enabled:true,minSuccessRate:80,maxP95Seconds:30,botFailures:2,readingFailures:3,creditDays:5,weeklyDigest:true};
const activeAlerts=[{key:'credits_low',severity:'warning',agent:'credits',title:'AI credits run out in about 6 days',detail:'348 of 1,000 left; the last week used about 58 a day, so they run out around 14 Jan, before they renew on 1 Feb.',link:'/agent-tracker?tab=costs',value:6,threshold:5},
 {key:'bot_failures',severity:'critical',agent:'meetings',title:'The meeting bot missed 3 sessions today',detail:'Most often: Nobody let the bot into the meeting. Your alert is 2 or more a day.',link:'/agent-tracker?tab=meetings',value:3,threshold:2}];
const digest={title:'Agents last week: 142 proposals, 96 approved, 21 meetings',lines:['Project agent: 38 readings, 142 proposals - 96 approved (21 by itself), 27 dismissed, 19 waiting.','Meetings: 21 of 24 attended by the bot, 18 sets of minutes sent.','AI credits: 406 used; at this pace they run out around 14 Jan, before they renew on 1 Feb.'],from:new Date(now-7*day).toISOString(),to:new Date(now).toISOString(),quiet:false};
const hints=[{projectId:pid,projectKey:'PAY',projectName:'Payments Core',kind:'CreateActionItem',decided:41,rate:98,level:2,message:'x'}];
const writes=[],errors=[],checks=[];
const browser=await chromium.launch({...(process.env.PM_BROWSER_EXECUTABLE?{executablePath:process.env.PM_BROWSER_EXECUTABLE}:{}),headless:true});
try{
 const make=async(theme)=>{
  const ctx=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:'block'});
  await ctx.addInitScript((t)=>{localStorage.setItem('pm_alerts_prompt','1');localStorage.setItem('pm_theme',t);},theme);
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),ep=url.pathname,method=req.method();
   if(url.origin!==origin){await route.abort();return;}
   if(ep.endsWith('/avatar')){await route.fulfill({status:404,body:''});return;}
   if(!ep.startsWith('/api/')){const file=path.resolve(dist,ep.startsWith('/assets/')?ep.slice(1):'index.html');assert.ok(file.startsWith(dist+path.sep));await route.fulfill({contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file),headers:ep.startsWith('/assets/')?{}:{'content-security-policy':csp}});return;}
   let data=[];
   if(ep==='/api/v1/ai/tracker'){const st=url.searchParams.get('status');const items=st?runs.filter(r=>r.status===st):runs;data={...tracker,total:items.length,runs:items.slice(0,25)};}
   else if(ep==='/api/v1/ai/tracker/fleet')data=fleet;
   else if(ep==='/api/v1/ai/tracker/health')data={configured:true,reachable:true,modelAvailable:true,provider:'Anthropic',model:'claude-sonnet-5-5',queueDepth:0,errorCode:null};
   else if(ep==='/api/v1/ai/tracker/cost')data=cost;
   else if(ep==='/api/v1/ai/tracker/alerts'&&method==='PUT'){writes.push({ep,b:req.postDataJSON()});alertSettings=req.postDataJSON();data={settings:alertSettings,active:activeAlerts,checkedAt:new Date(now).toISOString(),lastNotifiedCheck:null};}
   else if(ep==='/api/v1/ai/tracker/alerts')data={settings:alertSettings,active:activeAlerts,checkedAt:new Date(now).toISOString(),lastNotifiedCheck:null};
   else if(ep==='/api/v1/ai/tracker/digest/send'&&method==='POST'){writes.push({ep});data={sent:1};}
   else if(ep==='/api/v1/ai/tracker/digest')data=digest;
   else if(ep==='/api/v1/ai/tracker/autonomy-hints')data=hints;
   else if(ep==='/api/v1/ai/tracker/agent'&&method==='PUT'){writes.push({ep,b:req.postDataJSON()});tracker.agent.enabled=req.postDataJSON().enabled;data={enabled:tracker.agent.enabled};}
   else{
    assert.ok(method==='GET'||ep.endsWith('/auth/refresh'),`Unexpected write: ${method} ${ep}`);
    if(ep.endsWith('/auth/refresh'))data={accessToken:token,expiresAt:'2099-01-01T00:00:00Z',user};
    else if(ep==='/api/v1/me')data={user,workspaces:[ws],fingerprint:'preview',pendingConsent:[],current:{...ws,permissions:['projects.view','projects.edit','tasks.view','tasks.edit','org.manage','reports.view'],modules:{projects:3,tasks:3,calendar:3,work:3,ai:3,activity:3,documents:3,people:3,reports:3,billing:3},plan:{code:'BUSINESS',name:'Business',status:'Active'},entitlements:{AI_ASSISTANT:3}}};
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
 const noOverflow=(page,what)=>fitsPhone(page,what,assert);
 const tab=(page,name)=>page.locator('.trk-tabs button',{hasText:name}).click();
 // A full-page capture by growing the window to the page's height (Playwright's fullPage capture briefly re-lays the page out, which remounts it).
 const shot=async(page,name,full=true)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(1600);
  if(!full){await page.screenshot({path:path.join(out,name)});return;}
  const vp=page.viewportSize();const h=await page.evaluate(()=>document.documentElement.scrollHeight);
  await page.setViewportSize({width:vp.width,height:Math.min(6000,Math.max(vp.height,h))});await page.waitForTimeout(700);
  await page.screenshot({path:path.join(out,name)});await page.setViewportSize(vp);};

 let ctx=await make('light');
 let page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/preview-org/agent-tracker');
 await page.getByRole('heading',{name:'Agent Tracker'}).waitFor();
 await page.locator('.trk-agent').nth(3).waitFor();
 assert.equal(await page.locator('.trk-agent').count(),4);
 await page.locator('.recharts-bar-rectangle').first().waitFor({timeout:8000});checks.push('overview');
 await shot(page,'overview-1440.png');await noOverflow(page,'overview 1440');
 assert.equal(await page.locator('.trk-attention .trk-alert').count(),2);assert.ok(await page.locator('.trk-tab-count.sev-critical').isVisible());checks.push('attention');
 await page.getByRole('button',{name:'Check model health'}).click();await page.getByText('Model service reachable').waitFor();checks.push('health');

 await tab(page,'Assistant');await page.getByText('Where the time goes').waitFor();
 assert.ok(await page.getByText('find work').first().isVisible());checks.push('assistant');
 await shot(page,'assistant-1440.png');
 await tab(page,'Project agent');await page.getByText('Proposals by kind').waitFor();
 assert.ok(await page.getByText('Payments Core').first().isVisible());checks.push('project-agent');
 await page.getByText('Ready for more autonomy').waitFor();assert.ok(await page.locator('.trk-hints li',{hasText:'98%'}).isVisible());
 assert.ok(await page.getByText('Duplicate').isVisible());checks.push('trust');
 await shot(page,'project-agent-1440.png');
 await tab(page,'Meetings & follow-ups');await page.getByText('Commitments',{exact:true}).first().waitFor();checks.push('meetings');
 await shot(page,'meetings-1440.png');
 await tab(page,'Credits');await page.getByText('At this pace the credits run out').waitFor();await page.locator('.recharts-bar-rectangle').first().waitFor();
 assert.ok(await page.locator('.trk-cap.warn').first().isVisible());checks.push('costs');
 await shot(page,'costs-1440.png');
 await tab(page,'Alerts');await page.getByText('Needs attention now').waitFor();
 await page.locator('#thr-botFailures').fill('4');await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForTimeout(300);
 assert.equal(writes.find(w=>w.ep.endsWith('/alerts'))?.b.botFailures,4);checks.push('alert-settings');
 await page.getByRole('button',{name:'Preview',exact:true}).click();await page.getByText('Meetings: 21 of 24 attended').waitFor();
 await page.getByRole('button',{name:'Send me one now'}).click();await page.waitForTimeout(300);assert.ok(writes.some(w=>w.ep.endsWith('/digest/send')));checks.push('digest');
 await shot(page,'alerts-1440.png',false);
 await tab(page,'Runs');await page.locator('.trk-run').first().waitFor();
 await page.locator('.trk-run-head').first().click();await page.locator('.trk-waterfall li').nth(2).waitFor();checks.push('trace-waterfall');
 await page.locator('.trk-run.open').scrollIntoViewIfNeeded();await shot(page,'runs-1440.png',false);
 await page.locator('.trk-chips button',{hasText:/^failed$/i}).click();await page.waitForTimeout(400);
 assert.ok((await page.locator('.trk-pill').allInnerTexts()).every(t=>/failed/i.test(t)));checks.push('filter-outcome');
 await page.getByRole('button',{name:'Switch assistant off'}).click();await page.waitForTimeout(300);
 assert.deepEqual(writes.at(-1).b,{enabled:false});checks.push('switch');
 await page.close();await ctx.close();

 for(const theme of ['light','dark']){
  ctx=await make(theme);page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/preview-org/agent-tracker');await page.locator('.trk-agent').nth(3).waitFor();
  await shot(page,`overview-390-${theme}.png`);await noOverflow(page,`overview 390 ${theme}`);
  if(theme==='dark'){await page.setViewportSize({width:1440,height:1000});await shot(page,'overview-1440-dark.png');}
  else{
   await tab(page,'Assistant');await page.getByText('Where the time goes').waitFor();await shot(page,'assistant-390.png');await noOverflow(page,'assistant 390');
   await tab(page,'Runs');await page.locator('.trk-run-head').first().click();await page.locator('.trk-waterfall li').first().waitFor();await shot(page,'runs-390.png');await noOverflow(page,'runs 390');
   await tab(page,'Credits');await page.getByText('At this pace the credits run out').waitFor();await shot(page,'costs-390.png');await noOverflow(page,'costs 390');
   await tab(page,'Alerts');await page.getByText('Needs attention now').waitFor();await shot(page,'alerts-390.png');await noOverflow(page,'alerts 390');
  }
  checks.push(`phone-${theme}`);await page.close();await ctx.close();
 }
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,writes:writes.length,errors,scope:'Built frontend with synthetic fixtures; no live model calls.'},null,2));
 console.log(JSON.stringify({checks,writes:writes.length,errors}));
}finally{await browser.close();}
