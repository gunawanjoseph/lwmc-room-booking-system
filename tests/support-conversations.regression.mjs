import './roomops-regression-hooks.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const support=await import('../convex/support.ts');
const rules=await import('../convex/lib/supportRules.ts');
const {capabilitiesForRole,ROLES}=await import('../shared/roles.ts');
const admin={clerkUserId:'admin',displayName:'Administrator',email:'admin@example.com',role:'booking_manager',status:'active'};
const developer={clerkUserId:'dev',displayName:'Developer',email:'dev@example.com',role:'tech_support',status:'active'};
const recipient={_id:'recipient',email:'dev@example.com',active:true};
let sequence=0;
const requestId=()=>`request-${String(++sequence).padStart(16,'0')}`;
function actor(user=admin){globalThis.__roomopsActor=user;}
function input(extra={}){return {kind:'report',title:'Calendar problem',severity:'high',body:'Event remains in Calendar',attachmentIds:[],requestId:requestId(),...extra};}
async function report(ctx,extra={}){actor();return support.create.handler(ctx,input(extra));}
function fixture(){return context({users:[{_id:'u-admin',...admin},{_id:'u-dev',...developer}],techSupportEmails:[recipient]});}
function context(initial={}) {
  const tables=new Map(Object.entries(initial).map(([name,rows])=>[name,rows.map(row=>({...row}))]));
  const jobs=[];
  function rows(name){if(!tables.has(name))tables.set(name,[]);return tables.get(name);}
  const db={
    get:async id=>[...tables.values()].flat().find(row=>row._id===id)??null,
    insert:async(name,value)=>{const id=`${name}-${rows(name).length}`;rows(name).push({_id:id,...value});return id;},
    patch:async(id,patch)=>{const row=await db.get(id);assert.ok(row,`Missing ${id}`);Object.assign(row,patch);},
    delete:async id=>{for(const values of tables.values()){const i=values.findIndex(row=>row._id===id);if(i>=0)values.splice(i,1);}},
    query:name=>{
      let selected=[...rows(name)];const chain={
        withIndex:(_,fn)=>{const range={eq:(key,value)=>{selected=selected.filter(row=>row[key]===value);return range;},gt:(key,value)=>{selected=selected.filter(row=>row[key]>value);return range;},lt:(key,value)=>{selected=selected.filter(row=>row[key]<value);return range;}};fn?.(range);return chain;},
        order:direction=>{selected.sort((a,b)=>direction==='desc'?b.createdAt-a.createdAt:a.createdAt-b.createdAt);return chain;},
        filter:fn=>{selected=selected.filter(row=>fn({eq:(a,b)=>a===b,field:key=>row[key]}));return chain;},
        paginate:async opts=>({page:selected.slice(0,opts.numItems),isDone:selected.length<=opts.numItems,continueCursor:""}),
        collect:async()=>selected,take:async n=>selected.slice(0,n),unique:async()=>selected[0]??null,
      };return chain;
    },
  };
  return {db,jobs,rows,storage:{delete:async id=>jobs.push(["delete",id])},scheduler:{runAfter:async(...args)=>jobs.push(args)}};
}
test('technical support role has only support permissions; all active admin roles can view',()=>{
  assert.deepEqual(capabilitiesForRole('tech_support'),['support.view','support.develop']);
  for(const role of ROLES)assert.ok(capabilitiesForRole(role).includes('support.view'));
});
test('report saves initial message and queues technical recipients immediately',async()=>{
  const ctx=fixture();const id=await report(ctx);
  assert.equal((await ctx.db.get(id)).status,'open');assert.equal(ctx.rows('supportMessages').length,1);
  assert.equal(ctx.rows('supportParticipants').length,1);assert.equal(ctx.rows('supportDeliveries')[0].email,recipient.email);
  assert.ok(ctx.jobs.some(j=>j[0]===0&&j[1]==='sendSupportMessage'));
});
test('head admin reports still notify tech support',async()=>{
  actor({...admin,role:'head_admin'});const ctx=fixture();await support.create.handler(ctx,input());
  assert.equal(ctx.rows('supportDeliveries')[0].recipientKind,'technical');
});
test('create retry is idempotent and rejects a different body under same request',async()=>{
  actor();const ctx=fixture(),args=input();const first=await support.create.handler(ctx,args);
  assert.equal(await support.create.handler(ctx,args),first);assert.equal(ctx.rows('supportMessages').length,1);assert.equal(ctx.rows('supportDeliveries').length,1);
  await assert.rejects(support.create.handler(ctx,{...args,body:'different'}));
});
test('developer reply emails reporter, and admin follow-up emails tech support',async()=>{
  const ctx=fixture(),id=await report(ctx);actor(developer);
  await support.reply.handler(ctx,{threadId:id,body:'Investigating',attachmentIds:[],requestId:requestId()});
  assert.equal(ctx.rows('supportDeliveries')[1].email,admin.email);
  actor();await support.reply.handler(ctx,{threadId:id,body:'More detail',attachmentIds:[],requestId:requestId()});
  assert.equal(ctx.rows('supportDeliveries')[2].email,developer.email);
});
test('reply retries do not duplicate messages or email',async()=>{
  const ctx=fixture(),id=await report(ctx);const args={threadId:id,body:'Follow up',attachmentIds:[],requestId:requestId()};
  const first=await support.reply.handler(ctx,args);assert.equal(await support.reply.handler(ctx,args),first);
  assert.equal(ctx.rows('supportMessages').length,2);await assert.rejects(support.reply.handler(ctx,{...args,body:'changed'}));
});
test('only developer-capable roles may publish updates',async()=>{
  const ctx=fixture();actor();await assert.rejects(support.create.handler(ctx,input({kind:'announcement',announcementType:'feature'})));
  actor(developer);await support.create.handler(ctx,input({kind:'announcement',announcementType:'feature'}));
  assert.equal(ctx.rows('supportThreads')[0].announcementType,'feature');assert.equal(ctx.rows('supportDeliveries')[0].email,admin.email);
});
test('announcements exclude inactive users, developer accounts, and author',async()=>{
  const ctx=fixture();await ctx.db.insert('users',{...admin,clerkUserId:'removed',email:'removed@example.com',status:'removed'});
  actor(developer);await support.create.handler(ctx,input({kind:'announcement',announcementType:'bug_fixed'}));
  assert.deepEqual(ctx.rows('supportDeliveries').map(x=>x.email),[admin.email]);
});
test('announcement category is required',async()=>{
  actor(developer);await assert.rejects(support.create.handler(fixture(),input({kind:'announcement'})));
});
test('reporter can solve; reply reopens with a newer revision',async()=>{
  const ctx=fixture(),id=await report(ctx);await support.update.handler(ctx,{threadId:id,expectedRevision:0,status:'solved',severity:'high',requestId:requestId()});
  assert.equal((await ctx.db.get(id)).status,'solved');
  await support.reply.handler(ctx,{threadId:id,body:'Still broken',attachmentIds:[],requestId:requestId()});
  assert.equal((await ctx.db.get(id)).status,'open');assert.equal((await ctx.db.get(id)).revision,2);
});
test('another admin cannot change severity or resolve someone else’s report',async()=>{
  const ctx=fixture(),id=await report(ctx);actor({...admin,clerkUserId:'other'});
  await assert.rejects(support.update.handler(ctx,{threadId:id,expectedRevision:0,status:'solved',severity:'low',requestId:requestId()}));
  assert.equal((await ctx.db.get(id)).revision,0);
});
test('developer can triage; stale status edits fail without adding a message',async()=>{
  const ctx=fixture(),id=await report(ctx);actor(developer);
  await support.update.handler(ctx,{threadId:id,expectedRevision:0,status:'open',severity:'critical',requestId:requestId()});
  await assert.rejects(support.update.handler(ctx,{threadId:id,expectedRevision:0,status:'solved',severity:'low',requestId:requestId()}));
  assert.equal(ctx.rows('supportMessages').length,2);assert.equal((await ctx.db.get(id)).severity,'critical');
});
for(const user of [null,{...admin,status:'removed'},{...admin,status:'pending'}])test(`inactive or anonymous access denied (${user?.status??'anonymous'})`,async()=>{
  actor(user);const ctx=fixture();
  for(const [fn,args] of [[support.create,input()],[support.list,{kind:'report',paginationOpts:{numItems:10,cursor:null}}],[support.uploadViewer,{}],[support.attachmentStorage,{attachmentId:'x'}]])await assert.rejects(fn.handler(ctx,args));
});
async function attach(ctx,extra={}){return support.registerAttachment.handler(ctx,{storageId:'blob',name:'screen.png',contentType:'image/png',size:100,...extra});}
test('pictures are owner-bound until sent, then visible to support members',async()=>{
  actor();const ctx=fixture(),file=await attach(ctx);actor(developer);
  await assert.rejects(support.attachmentStorage.handler(ctx,{attachmentId:file}));
  actor();const id=await report(ctx,{attachmentIds:[file],body:''});
  assert.equal(ctx.rows('supportMessages')[0].threadId,id);actor(developer);
  assert.equal((await support.attachmentStorage.handler(ctx,{attachmentId:file})).storageId,'blob');
});
for(const mode of ['foreign','expired','used','duplicate','six'])test(`reject ${mode} attachment submission`,async()=>{
  const ctx=fixture(),id=await report(ctx);const file=await attach(ctx);
  if(mode==='foreign')await ctx.db.patch(file,{owner:'other'});
  if(mode==='expired')await ctx.db.patch(file,{expiresAt:0});
  if(mode==='used')await ctx.db.patch(file,{messageId:'old'});
  const files=mode==='duplicate'?[file,file]:mode==='six'?['1','2','3','4','5','6']:[file];
  await assert.rejects(support.reply.handler(ctx,{threadId:id,body:'Attached',attachmentIds:files,requestId:requestId()}));
  assert.equal(ctx.rows('supportMessages').length,1);
});
test('reject empty, oversized, or unsupported uploads and cap staged images',async()=>{
  actor();const ctx=fixture();for(const extra of [{size:0},{size:5242881},{contentType:'image/svg+xml'}])await assert.rejects(attach(ctx,extra));
  for(let i=0;i<20;i++)await attach(ctx);await assert.rejects(attach(ctx));
});
test('cleaner deletes expired drafts but preserves attached images',async()=>{
  actor();const ctx=fixture();const a=await attach(ctx),b=await attach(ctx);await ctx.db.patch(a,{expiresAt:0});await ctx.db.patch(b,{expiresAt:0,messageId:'sent'});
  await support.cleanAttachment.handler(ctx,{attachmentId:a});await support.cleanAttachment.handler(ctx,{attachmentId:b});
  assert.equal(await ctx.db.get(a),null);assert.ok(await ctx.db.get(b));
});
test('discard cannot delete another user’s picture or sent evidence',async()=>{
  actor();const ctx=fixture(),file=await attach(ctx);actor(developer);await assert.rejects(support.discardAttachment.handler(ctx,{attachmentId:file}));
  actor();await report(ctx,{attachmentIds:[file]});await assert.rejects(support.discardAttachment.handler(ctx,{attachmentId:file}));
});
test('notification lease excludes concurrent workers and ignores stale completion',async()=>{
  const ctx=fixture();await report(ctx);const deliveryId=ctx.rows('supportDeliveries')[0]._id;
  assert.ok(await support.claimDelivery.handler(ctx,{deliveryId,token:'one'}));assert.equal(await support.claimDelivery.handler(ctx,{deliveryId,token:'two'}),null);
  await support.finishDelivery.handler(ctx,{deliveryId,token:'two'});assert.equal((await ctx.db.get(deliveryId)).status,'sending');
  await support.finishDelivery.handler(ctx,{deliveryId,token:'one'});assert.equal((await ctx.db.get(deliveryId)).status,'sent');
});
test('disabled technical recipients and revoked admins are cancelled before sending',async()=>{
  const ctx=fixture(),id=await report(ctx);await ctx.db.patch('recipient',{active:false});
  const first=ctx.rows('supportDeliveries')[0]._id;assert.equal(await support.claimDelivery.handler(ctx,{deliveryId:first,token:'a'}),null);assert.equal((await ctx.db.get(first)).status,'cancelled');
  actor(developer);await support.reply.handler(ctx,{threadId:id,body:'Fix',attachmentIds:[],requestId:requestId()});await ctx.db.patch('u-admin',{status:'removed'});
  const second=ctx.rows('supportDeliveries')[1]._id;assert.equal(await support.claimDelivery.handler(ctx,{deliveryId:second,token:'b'}),null);assert.equal((await ctx.db.get(second)).status,'cancelled');
});
test('failed deliveries retry five attempts then require developer retry',async()=>{
  const ctx=fixture();await report(ctx);const deliveryId=ctx.rows('supportDeliveries')[0]._id;
  for(let i=1;i<=5;i++){await support.claimDelivery.handler(ctx,{deliveryId,token:`t${i}`});await support.finishDelivery.handler(ctx,{deliveryId,token:`t${i}`,error:'secret-value'});assert.equal((await ctx.db.get(deliveryId)).status,i<5?'pending':'failed');}
  assert.ok(!(await ctx.db.get(deliveryId)).error.includes('secret-value'));
  await assert.rejects(support.retryNotifications.handler(ctx,{messageId:ctx.rows('supportMessages')[0]._id}));actor(developer);
  await support.retryNotifications.handler(ctx,{messageId:ctx.rows('supportMessages')[0]._id});assert.equal((await ctx.db.get(deliveryId)).attempts,0);
});
test('expired delivery lease recovers while live lease remains protected',async()=>{
  const ctx=fixture();await report(ctx);const deliveryId=ctx.rows('supportDeliveries')[0]._id;await support.claimDelivery.handler(ctx,{deliveryId,token:'lease'});
  await support.recoverDelivery.handler(ctx,{deliveryId,token:'lease'});assert.equal((await ctx.db.get(deliveryId)).status,'sending');
  await ctx.db.patch(deliveryId,{leaseExpiresAt:0});await support.recoverDelivery.handler(ctx,{deliveryId,token:'lease'});assert.equal((await ctx.db.get(deliveryId)).status,'pending');
});
test('message query exposes attachment metadata without public storage identifiers',async()=>{
  const ctx=fixture();actor();const attachment=await attach(ctx);const id=await report(ctx,{attachmentIds:[attachment]});
  const result=await support.messages.handler(ctx,{threadId:id,paginationOpts:{numItems:30,cursor:null}});
  assert.equal(result.page[0].attachments[0].storageId,undefined);assert.deepEqual(result.page[0].emailStatus,{sent:0,pending:1,failed:0,cancelled:0});
});
test('text and image rules reject unsafe formats and preserve plain text',()=>{
  assert.throws(()=>rules.supportText('  ',160));assert.throws(()=>rules.supportText('a'.repeat(161),160));assert.throws(()=>rules.validRequestId('short'));
  assert.equal(rules.supportText(' <script>text</script> ',100),'<script>text</script>');
  assert.equal(rules.imageContentType(Buffer.from('<svg></svg>')),null);assert.equal(rules.imageContentType(Buffer.from([137,80,78,71,13,10,26,10])),'image/png');
});
test('expired staged pictures do not hide the upload quota',async()=>{
  actor();const ctx=fixture();for(let i=0;i<25;i++)await ctx.db.insert('supportAttachments',{owner:admin.clerkUserId,expiresAt:0});
  for(let i=0;i<20;i++)await attach(ctx);await assert.rejects(attach(ctx));
});
const realAuth=await import('../convex/lib/auth.ts');
test('real authorization denies anonymous, removed, and unconfigured head accounts',async()=>{
  const ctx=fixture();ctx.auth={getUserIdentity:async()=>null};await assert.rejects(realAuth.requireCapability(ctx,'support.view'));
  ctx.auth.getUserIdentity=async()=>({subject:'admin'});assert.equal((await realAuth.requireCapability(ctx,'support.view')).clerkUserId,'admin');
  await ctx.db.patch('u-admin',{status:'removed'});await assert.rejects(realAuth.requireCapability(ctx,'support.view'));
  const before=process.env.HEAD_ADMIN_CLERK_USER_ID;process.env.HEAD_ADMIN_CLERK_USER_ID='different-head';
  try{await ctx.db.patch('u-admin',{status:'active',role:'head_admin'});await assert.rejects(realAuth.requireCapability(ctx,'support.view'));}finally{if(before===undefined)delete process.env.HEAD_ADMIN_CLERK_USER_ID;else process.env.HEAD_ADMIN_CLERK_USER_ID=before;}
});
test('real authorization permits developer support but rejects booking mutation permissions',async()=>{
  const ctx=fixture();ctx.auth={getUserIdentity:async()=>({subject:'dev'})};assert.equal((await realAuth.requireCapability(ctx,'support.develop')).role,'tech_support');await assert.rejects(realAuth.requireCapability(ctx,'bookings.edit'));
});
await import('../convex/http.ts');
function route(method){return globalThis.__roomopsRoutes.find(r=>r.path==='/support/image'&&r.method===method).handler;}
async function withSite(run){const old=process.env.APP_BASE_URL;process.env.APP_BASE_URL='https://roomops.example.test';try{await run();}finally{if(old===undefined)delete process.env.APP_BASE_URL;else process.env.APP_BASE_URL=old;}}
function imageRequest(method,body,extra={}){return new Request('https://sample.convex.site/support/image?id=picture',{method,headers:{Origin:'https://roomops.example.test','Content-Type':'image/png',...extra},...(body?{body}: {})});}
test('private image routes reject unapproved origins and unauthenticated readers/uploaders',async()=>withSite(async()=>{
  assert.equal((await route('OPTIONS')({},imageRequest('OPTIONS',null,{Origin:'https://other.example'}))).status,403);
  assert.equal((await route('OPTIONS')({},imageRequest('OPTIONS'))).status,204);
  const ctx={runQuery:async()=>{throw new Error('unauthenticated');}};
  for(const method of ['GET','POST'])assert.equal((await route(method)(ctx,imageRequest(method))).status,403);
}));
test('image upload enforces streamed size cap and rejects HTML/SVG disguised as images',async()=>withSite(async()=>{
  const ctx={runQuery:async()=>({subject:'admin'})};
  assert.equal((await route('POST')(ctx,imageRequest('POST','<svg onload="alert(1)"></svg>'))).status,415);
  assert.equal((await route('POST')(ctx,imageRequest('POST',new Uint8Array(5242881)))).status,413);
}));
test('upload cleans stored blob if metadata cannot be saved',async()=>withSite(async()=>{
  let deleted;const ctx={runQuery:async()=>({subject:'admin'}),storage:{store:async()=> 'blob',delete:async id=>{deleted=id;}},runMutation:async()=>{throw new Error('quota');}};
  const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);assert.equal((await route('POST')(ctx,imageRequest('POST',bytes))).status,400);assert.equal(deleted,'blob');
}));
test('successful private upload binds metadata and download disables caching',async()=>withSite(async()=>{
  let metadata;const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);
  const ctx={runQuery:async name=>name==='uploadViewer'?{subject:'admin'}:{storageId:'blob',contentType:'image/png'},storage:{store:async()=> 'blob',get:async()=>new Blob([bytes],{type:'image/png'})},runMutation:async(_,args)=>{metadata=args;return 'attachment';}};
  const uploaded=await route('POST')(ctx,imageRequest('POST',bytes,{'X-File-Name':'screen%20shot.png'}));assert.equal(uploaded.status,201);assert.equal(metadata.name,'screen shot.png');assert.equal(metadata.size,8);
  const downloaded=await route('GET')(ctx,imageRequest('GET'));assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('cache-control'),'no-store');assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');assert.equal((await downloaded.arrayBuffer()).byteLength,8);
}));
test('support email includes conversation link, escapes HTML, and records delivery',async()=>{
  const emails=await import('../convex/emailNotifications.ts');
  const settings={APP_BASE_URL:'https://roomops.example.test',GMAIL_CLIENT_ID:'fake-client',GMAIL_CLIENT_SECRET:'fake-secret',GMAIL_REFRESH_TOKEN:'fake-refresh',GMAIL_FROM_EMAIL:'sender@example.com'};
  const previous=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));const oldFetch=globalThis.fetch;let mime='',finished;
  Object.assign(process.env,settings);globalThis.fetch=async(url,init)=>{if(String(url).includes('oauth2'))return new Response(JSON.stringify({access_token:'fake',expires_in:3600}));mime=Buffer.from(JSON.parse(init.body).raw,'base64url').toString();return new Response(JSON.stringify({id:'accepted'}));};
  try{
    await emails.sendSupportMessage.handler({runMutation:async(name,args)=>{if(name==='claimDelivery')return {email:developer.email,thread:{_id:'thread-123',title:'Bug',severity:'high',status:'open',kind:'report'},message:{authorName:'Admin',authorKind:'admin',body:'<script>alert(1)</script>',attachmentIds:['picture']}};if(name==='finishDelivery')finished=args;}},{deliveryId:'delivery'});
    assert.match(mime,/To: dev@example.com/);assert.match(mime,/support\?thread=thread-123/);assert.match(mime,/&lt;script&gt;/);assert.match(mime,/Sign in to view/);assert.match(mime,/not imported/);assert.equal(finished.error,undefined);
  }finally{globalThis.fetch=oldFetch;for(const[k,value]of Object.entries(previous)){if(value===undefined)delete process.env[k];else process.env[k]=value;}}
});
test('support sender records configuration failure for retry',async()=>{
  const emails=await import('../convex/emailNotifications.ts');const old=process.env.APP_BASE_URL;delete process.env.APP_BASE_URL;let finished;
  try{await emails.sendSupportMessage.handler({runMutation:async(name,args)=>name==='claimDelivery'?{thread:{},message:{}}:(finished=args)},{deliveryId:'delivery'});assert.match(finished.error,/APP_BASE_URL/);}finally{if(old!==undefined)process.env.APP_BASE_URL=old;}
});
