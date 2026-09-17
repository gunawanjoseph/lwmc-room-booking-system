import './roomops-regression-hooks.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
globalThis.__roomopsRealAuth=true;
process.env.DEVELOPER_EMAIL='dev@example.com';
process.env.HEAD_ADMIN_CLERK_USER_ID='head';
const users=await import('../convex/users.ts');
const auth=await import('../convex/lib/auth.ts');
const actionAuth=await import('../convex/lib/actionAuth.ts');
const identityRules=await import('../convex/lib/developerIdentity.ts');
const support=await import('../convex/support.ts');
const alerts=await import('../convex/techSupport.ts');
const {CAPABILITIES}=await import('../shared/roles.ts');
const developer={_id:'developer',clerkUserId:'dev',email:'dev@example.com',displayName:'Developer',role:'developer',status:'active'};
const head={_id:'head-row',clerkUserId:'head',email:'head@example.com',displayName:'Head',role:'head_admin',status:'active'};
const admin={_id:'admin',clerkUserId:'admin',email:'admin@example.com',displayName:'Admin',role:'booking_viewer',status:'active'};
function fixture(subject='head',extraUsers=[]){const ctx=context({users:[developer,head,admin,...extraUsers]});const known=[developer,head,admin,...extraUsers].find(u=>u.clerkUserId===subject);ctx.identity={subject,email:known?.email??'new@example.com',emailVerified:true};ctx.auth={getUserIdentity:async()=>ctx.identity};ctx.runQuery=async(name,args)=>{assert.equal(name,'authorizationBySubject');return users.authorizationBySubject.handler(ctx,args);};return ctx;}
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
test('developer configuration accepts one normalized email and fails closed on lists or invalid values',()=>{
  try{
    process.env.DEVELOPER_EMAIL='  DEV@Example.COM  ';assert.equal(identityRules.configuredDeveloperEmail(),'dev@example.com');
    for(const value of ['', 'dev@example.com,other@example.com','dev@example.com;other@example.com','dev@example.com other@example.com','bad','@example.com']){process.env.DEVELOPER_EMAIL=value;assert.equal(identityRules.configuredDeveloperEmail(),null);}
  }finally{process.env.DEVELOPER_EMAIL='dev@example.com';}
});
test('first developer login creates an active account without head approval and is idempotent',async()=>{
  const ctx=fixture('new-dev');ctx.identity.email='DEV@example.com';
  const id=await users.ensureDeveloper.handler(ctx,{});assert.equal((await ctx.db.get(id)).role,'developer');assert.equal((await ctx.db.get(id)).status,'active');
  const count=ctx.rows('users').length,jobs=ctx.jobs.length;assert.equal(await users.ensureDeveloper.handler(ctx,{}),id);assert.equal(ctx.rows('users').length,count);assert.equal(ctx.jobs.length,jobs);
  const profile=await users.me.handler(ctx,{});assert.equal(profile.roleLabel,'Developer');assert.deepEqual(profile.capabilities,CAPABILITIES);
});
test('ordinary administrator sign-in never self-activates or elevates',async()=>{
  const ctx=fixture('ordinary');assert.equal(await users.ensureDeveloper.handler(ctx,{}),null);assert.equal(ctx.rows('users').length,3);
  const result=await users.submitRegistration.handler(ctx,{displayName:'Ordinary',requestedRole:'booking_manager'});assert.deepEqual(result,{role:'booking_viewer',status:'pending'});
});
for(const verified of [false,undefined,'true'])test(`unverified or invalid email verification claim cannot activate developer (${verified})`,async()=>{
  const ctx=fixture('new-dev');ctx.identity={subject:'new-dev',email:'dev@example.com',emailVerified:verified};
  assert.equal(await users.ensureDeveloper.handler(ctx,{}),null);await assert.rejects(users.submitRegistration.handler(ctx,{displayName:'Developer'}));assert.equal(ctx.rows('users').length,3);
});
test('stored developer role and email cannot substitute for the current verified identity',async()=>{
  const ctx=fixture('dev');ctx.identity.email='impostor@example.com';await assert.rejects(auth.requireCapability(ctx,'users.manage'));
  ctx.identity.email='dev@example.com';ctx.identity.emailVerified=false;await assert.rejects(auth.requireCapability(ctx,'bookings.view'));
  assert.equal((await users.me.handler(ctx,{})).status,'removed');
});
test('developer receives every feature permission through both query/mutation and action guards',async()=>{
  const ctx=fixture('dev');for(const capability of CAPABILITIES){assert.equal((await auth.requireCapability(ctx,capability)).role,'developer');assert.equal((await actionAuth.requireActionCapability(ctx,capability)).role,'developer');}
  assert.equal((await auth.requireHeadAdmin(ctx)).role,'developer');assert.equal((await actionAuth.requireActionHeadAdmin(ctx)).role,'developer');
});
test('developer login and access do not depend on head administrator being configured',async()=>{
  const old=process.env.HEAD_ADMIN_CLERK_USER_ID;delete process.env.HEAD_ADMIN_CLERK_USER_ID;
  try{const ctx=fixture('fresh');ctx.identity.email='dev@example.com';await users.ensureDeveloper.handler(ctx,{});assert.equal((await auth.requireHeadAdmin(ctx)).role,'developer');assert.ok(await users.listForManagement.handler(ctx,{}));}finally{process.env.HEAD_ADMIN_CLERK_USER_ID=old;}
});
test('existing legacy developer is activated by verified identity; other legacy accounts lose access',async()=>{
  const ctx=fixture('old',[{...developer,_id:'legacy',clerkUserId:'old',role:'tech_support',status:'pending'}]);
  await users.ensureDeveloper.handler(ctx,{});assert.equal((await ctx.db.get('legacy')).role,'developer');assert.equal((await ctx.db.get('legacy')).status,'active');
  ctx.identity={subject:'other',email:'other@example.com',emailVerified:true};await ctx.db.insert('users',{...developer,clerkUserId:'other',email:'other@example.com',role:'tech_support'});
  assert.equal(await users.ensureDeveloper.handler(ctx,{}),null);await assert.rejects(auth.requireCapability(ctx,'support.view'));
});
test('developer email rotation or removal revokes old account on the next request, including actions',async()=>{
  const ctx=fixture('dev');try{for(const value of ['new@example.com','']){process.env.DEVELOPER_EMAIL=value;await assert.rejects(auth.requireCapability(ctx,'bookings.edit'));await assert.rejects(actionAuth.requireActionHeadAdmin(ctx));assert.deepEqual((await users.me.handler(ctx,{})).capabilities,[]);}}finally{process.env.DEVELOPER_EMAIL='dev@example.com';}
});
for(const target of ['developer','configured ordinary','legacy'])test(`head cannot approve, reject, demote or remove ${target} developer account`,async()=>{
  const ctx=fixture();if(target==='configured ordinary')await ctx.db.patch('developer',{role:'booking_viewer',status:'pending'});if(target==='legacy')await ctx.db.patch('developer',{role:'tech_support',email:'old@example.com'});
  const before=structuredClone(await ctx.db.get('developer'));
  for(const [fn,args] of [[users.reviewRegistration,{userId:'developer',decision:'approve',role:'booking_manager'}],[users.reviewRegistration,{userId:'developer',decision:'reject'}],[users.changeRole,{userId:'developer',role:'booking_viewer'}],[users.removeUser,{userId:'developer'}]])await assert.rejects(fn.handler(ctx,args),/Developer accounts/);
  assert.deepEqual(await ctx.db.get('developer'),before);
  const listing=await users.listForManagement.handler(ctx,{});assert.equal(listing.find(u=>u._id==='developer').isDeveloperProtected,true);
});
test('head cannot grant either current or legacy developer role',async()=>{
  const ctx=fixture();for(const role of ['developer','tech_support']){
    await assert.rejects(users.changeRole.handler(ctx,{userId:'admin',role}));await assert.rejects(users.reviewRegistration.handler(ctx,{userId:'admin',decision:'approve',role}));
  }assert.equal((await ctx.db.get('admin')).role,'booking_viewer');
});
test('developer can manage administrator accounts and head retains ordinary user management',async()=>{
  const ctx=fixture('dev');await users.changeRole.handler(ctx,{userId:'admin',role:'booking_manager'});assert.equal((await ctx.db.get('admin')).role,'booking_manager');
  ctx.identity={subject:'head',email:'head@example.com',emailVerified:true};await users.changeRole.handler(ctx,{userId:'admin',role:'booking_approver'});assert.equal((await ctx.db.get('admin')).role,'booking_approver');
});
test('action authorization cannot request someone else’s identity',async()=>{
  const ctx=fixture('admin');await assert.rejects(users.authorizationBySubject.handler(ctx,{clerkUserId:'dev'}),/mismatch/);
});
test('head and developer cannot edit the environment-owned notification address through stale API',async()=>{
  for(const subject of ['head','dev']){const ctx=fixture(subject);await assert.rejects(alerts.save.handler(ctx,{email:'replacement@example.com',active:true}),/DEVELOPER_EMAIL/);assert.equal((await alerts.list.handler(ctx,{})).developerEmail,'dev@example.com');assert.equal(ctx.rows('techSupportEmails').length,0);}
});
test('any administrator and developer may close and reopen another administrator’s report',async()=>{
  const ctx=fixture('head');const threadId=await support.create.handler(ctx,{kind:'report',title:'Issue',severity:'medium',body:'Details',attachmentIds:[],requestId:'report-request-0001'});
  let revision=0;for(const subject of ['admin','dev']){
    const u=subject==='admin'?admin:developer;ctx.identity={subject,email:u.email,emailVerified:true};
    assert.equal((await support.get.handler(ctx,{threadId})).canManage,true);
    for(const status of ['solved','open'])await support.update.handler(ctx,{threadId,expectedRevision:revision++,status,severity:'medium',requestId:`status-request-${revision.toString().padStart(5,'0')}`});
  }
  assert.equal((await ctx.db.get(threadId)).status,'open');assert.equal((await ctx.db.get(threadId)).revision,4);
});
test('missing developer configuration is visible and never falls back to legacy recipients',async()=>{
  const old=process.env.DEVELOPER_EMAIL;delete process.env.DEVELOPER_EMAIL;
  try{const ctx=fixture('admin');await ctx.db.insert('techSupportEmails',{email:'legacy@example.com',active:true});assert.equal((await support.configuration.handler(ctx,{})).hasRecipients,false);await support.create.handler(ctx,{kind:'report',title:'Report',severity:'low',body:'Saved without email',attachmentIds:[],requestId:'no-developer-request'});assert.equal(ctx.rows('supportDeliveries').length,0);}finally{process.env.DEVELOPER_EMAIL=old;}
});
