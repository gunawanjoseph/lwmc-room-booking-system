import './roomops-regression-hooks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const requests = await import('../convex/bookingRequests.ts');
const rules = await import('../convex/lib/requesterRules.ts');
const token = 'a'.repeat(64);
const now = Date.now();
const hour = 3600000;
function booking(extra={}) { return { _id:'booking', status:'approved', requesterEmail:'owner@example.com', requesterName:'Owner',
  room:'Shema Space', eventName:'Original', timezone:'Asia/Singapore', startAt:now+5*hour,endAt:now+6*hour,
  calendarSyncStatus:'synced',occurrences:[{sequence:7,startAt:now+5*hour,endAt:now+6*hour},
  {sequence:3,startAt:now+24*hour,endAt:now+25*hour,room:'Board Room',details:{eventName:'Edited event'}}],...extra }; }
function context(initial={}) {
  const tables=new Map(Object.entries(initial).map(([name,rows])=>[name,rows.map(row=>({...row}))]));
  const jobs=[];
  function rows(name){if(!tables.has(name))tables.set(name,[]);return tables.get(name);}
  const db={
    get:async id=>structuredClone([...tables.values()].flat().find(row=>row._id===id)??null),
    insert:async(name,value)=>{const id=`${name}-${rows(name).length}`;rows(name).push({_id:id,...value});return id;},
    patch:async(id,patch)=>{const row=[...tables.values()].flat().find(row=>row._id===id);assert.ok(row,`Missing ${id}`);Object.assign(row,patch);},
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

function setup(extra={}) { return context({bookings:[booking(extra)],requesterLinks:[{_id:'link',bookingId:'booking',token,email:'owner@example.com'}]}); }
async function args(ctx, extra={}) { const view=await requests.view.handler(ctx,{token});return {token,version:view.version,sequence:7,scope:'occurrence',kind:'change',message:'Move the start to 3pm',...extra}; }

test('two hour boundary is inclusive and enforced in milliseconds',()=>{
  const meetings=rules.requestMeetings(booking({occurrences:undefined,startAt:now+2*hour}));
  assert.doesNotThrow(()=>rules.checkRequestWindow(meetings,now));
  assert.throws(()=>rules.checkRequestWindow(meetings,now+1),/two hours/);
  assert.throws(()=>rules.checkRequestWindow([],now));
});
test('following uses current dates rather than sequence number and respects latest overrides',()=>{
  const b=booking();assert.deepEqual(rules.requestScope(b,7,'following').map(x=>x.sequence),[7,3]);
  const tail=rules.requestScope(b,3,'following');assert.equal(tail.length,1);assert.equal(tail[0].title,'Edited event');assert.equal(tail[0].room,'Board Room');
  assert.throws(()=>rules.requestScope(b,999,'occurrence'));
});
test('public projection exposes no database identifiers or recipient email',async()=>{
  const result=await requests.view.handler(setup(),{token});
  assert.equal(result.meetings.length,2);
  assert.doesNotMatch(JSON.stringify(result),/bookingId|userId|requesterEmail|owner@example/);
});
test('malformed and unknown tokens return the same unavailable result',async()=>{
  for(const bad of ['', 'booking','a'.repeat(63),'b'.repeat(64),'a'.repeat(10000)]) assert.equal(await requests.view.handler(setup(),{token:bad}),null);
});
test('changed recipient, rejection and deletion revoke access',async()=>{
  for(const extra of [{requesterEmail:'other@example.com'},{status:'rejected'}]) assert.equal(await requests.view.handler(setup(extra),{token}),null);
  const ctx=setup();await ctx.db.delete('booking');assert.equal(await requests.view.handler(ctx,{token}),null);
});
test('recipient comparison is case insensitive',async()=>{
  assert.ok(await requests.view.handler(setup({requesterEmail:' OWNER@EXAMPLE.COM '}),{token}));
});
test('one occurrence request stores a snapshot but never alters booking or schedules calendar work',async()=>{
  const ctx=setup();const before=await ctx.db.get('booking');await requests.submit.handler(ctx,await args(ctx));
  const req=ctx.rows('bookingRequests')[0];assert.equal(req.status,'pending');assert.equal(JSON.parse(req.snapshot).length,1);
  assert.deepEqual(await ctx.db.get('booking'),before);assert.equal(ctx.jobs.length,0);
  assert.doesNotMatch(JSON.stringify(ctx.rows('auditLogs')),new RegExp(token));
});
test('following cancellation captures only selected tail and allows an empty reason',async()=>{
  const ctx=setup();await requests.submit.handler(ctx,await args(ctx,{kind:'cancel',scope:'following',sequence:3,message:''}));
  assert.deepEqual(JSON.parse(ctx.rows('bookingRequests')[0].snapshot).map(x=>x.sequence),[3]);
});
test('server rejects a request submitted after the deadline even with a valid link and version',async()=>{
  const ctx=setup({occurrences:undefined,startAt:Date.now()+hour});
  await assert.rejects(requests.submit.handler(ctx,await args(ctx,{sequence:0})),/two hours/);
});
test('old and near-term occurrences do not block later recurring meetings',async()=>{
  const ctx=setup({occurrences:[{sequence:0,startAt:now-hour,endAt:now},{sequence:1,startAt:now+hour,endAt:now+2*hour},{sequence:2,startAt:now+24*hour,endAt:now+25*hour}]});
  await requests.submit.handler(ctx,await args(ctx,{sequence:2,scope:'following'}));
  assert.equal(JSON.parse(ctx.rows('bookingRequests')[0].snapshot).length,1);
});
test('repeated admin edits invalidate previously rendered version',async()=>{
  const ctx=setup();const old=await args(ctx);
  await ctx.db.patch('booking',{eventName:'New title'});
  await assert.rejects(requests.submit.handler(ctx,old),/changed/);
  await requests.submit.handler(ctx,await args(ctx));assert.equal(ctx.rows('bookingRequests').length,1);
});
test('deleted selected occurrence cannot be requested',async()=>{
  const ctx=setup();await assert.rejects(requests.submit.handler(ctx,await args(ctx,{sequence:999})),/no longer available/);
});
test('identical retry is idempotent and another pending request is rejected',async()=>{
  const ctx=setup();const input=await args(ctx);await requests.submit.handler(ctx,input);await requests.submit.handler(ctx,input);
  assert.equal(ctx.rows('bookingRequests').length,1);
  await assert.rejects(requests.submit.handler(ctx,{...input,kind:'cancel'}),/already a request/);
});
test('message size and required change description are validated server-side',async()=>{
  for(const message of ['','1234','a'.repeat(4001)]) {const ctx=setup();await assert.rejects(requests.submit.handler(ctx,await args(ctx,{message})));}
});
test('in-flight calendar edits and deletion block new requests',async()=>{
  for(const extra of [{calendarSyncStatus:'creating'},{deletionToken:'lease'}]) {const ctx=setup(extra);await assert.rejects(requests.submit.handler(ctx,await args(ctx)),/being updated/);}
});
test('only approval worker with matching lease and recipient can create private links',async()=>{
  const ctx=context({bookings:[booking()],emailDeliveries:[{_id:'delivery',bookingId:'booking',kind:'requester_approved',status:'sending',leaseToken:'lease',recipientEmail:'owner@example.com'}]});
  assert.equal(await requests.issueLink.handler(ctx,{deliveryId:'delivery',leaseToken:'wrong'}),null);
  const issued=await requests.issueLink.handler(ctx,{deliveryId:'delivery',leaseToken:'lease'});assert.match(issued,/^[0-9a-f]{64}$/);
  assert.equal(await requests.issueLink.handler(ctx,{deliveryId:'delivery',leaseToken:'lease'}),issued);
  assert.equal(ctx.rows('requesterLinks').length,1);
  await ctx.db.patch('delivery',{recipientEmail:'wrong@example.com'});assert.equal(await requests.issueLink.handler(ctx,{deliveryId:'delivery',leaseToken:'lease'}),null);
});
test('admin list and resolution reject anonymous or insufficient privileges',async()=>{
  const ctx=setup();globalThis.__roomopsActor=null;
  try {await assert.rejects(requests.list.handler(ctx,{status:'pending',paginationOpts:{numItems:20}}),/Access denied/);
    await assert.rejects(requests.resolve.handler(ctx,{requestId:'x',outcome:'declined',response:'No'}),/Access denied/);
  } finally {delete globalThis.__roomopsActor;}
});
test('completion requires real synced changes to every affected occurrence',async()=>{
  const ctx=setup();await requests.submit.handler(ctx,await args(ctx,{scope:'following'}));const requestId=ctx.rows('bookingRequests')[0]._id;
  const input={requestId,outcome:'completed',response:'Updated both meetings'};
  await assert.rejects(requests.resolve.handler(ctx,input),/Apply the changes/);
  const b=await ctx.db.get('booking');b.occurrences[0].details={eventName:'Changed first'};await ctx.db.patch('booking',{occurrences:b.occurrences});
  await assert.rejects(requests.resolve.handler(ctx,input),/every requested meeting/);
  b.occurrences[1].details={eventName:'Changed second'};await ctx.db.patch('booking',{occurrences:b.occurrences,calendarSyncStatus:'failed'});
  await assert.rejects(requests.resolve.handler(ctx,input),/sync first/);
  await ctx.db.patch('booking',{calendarSyncStatus:'synced'});await requests.resolve.handler(ctx,input);
  assert.equal((await ctx.db.get(requestId)).status,'completed');
});
test('cancellation completion requires all scoped occurrences removed',async()=>{
  const ctx=setup();await requests.submit.handler(ctx,await args(ctx,{scope:'following',kind:'cancel',message:''}));const requestId=ctx.rows('bookingRequests')[0]._id;
  const input={requestId,outcome:'completed',response:'Cancelled'};
  await assert.rejects(requests.resolve.handler(ctx,input),/Remove all/);
  await ctx.db.delete('booking');await requests.resolve.handler(ctx,input);assert.equal((await ctx.db.get(requestId)).status,'completed');
});
test('decline records response without changing booking and cannot be resolved twice',async()=>{
  const ctx=setup();await requests.submit.handler(ctx,await args(ctx));const requestId=ctx.rows('bookingRequests')[0]._id;
  const before=await ctx.db.get('booking');const input={requestId,outcome:'declined',response:'Requested room is occupied.'};await requests.resolve.handler(ctx,input);
  assert.deepEqual(await ctx.db.get('booking'),before);assert.equal((await requests.view.handler(ctx,{token})).requests[0].response,input.response);
  await assert.rejects(requests.resolve.handler(ctx,input),/already been reviewed/);
});
test('private request route has no Clerk provider, no indexing, and middleware bypass is exact',()=>{
  const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
  assert.doesNotMatch(read('../app/layout.tsx'),/ClerkProvider/);
  assert.match(read('../app/(roomops)/layout.tsx'),/ClerkProvider/);
  assert.match(read('../app/booking-request/page.tsx'),/index: false/);
  assert.match(read('../app/booking-request/page.tsx'),/referrer: "no-referrer"/);
  assert.match(read('../proxy.ts'),/=== "\/booking-request"/);
  assert.match(read('../components/request-booking.tsx'),/window.location.hash/);
});
