import './roomops-regression-hooks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
process.env.BOOKING_MINISTRIES_JSON = JSON.stringify(['Youth','Office']);
const requests = await import('../convex/bookingRequests.ts');
const rules = await import('../convex/lib/requesterRules.ts');
const token = 'a'.repeat(64);
const now = Date.now();
const hour = 3600000;
function booking(extra={}) { return { _id:'booking', status:'approved', requesterEmail:'owner@example.com', requesterName:'Owner',
  jotformSubmissionId:'123', jotformFormId:'form', createdAt:now, roomKey:'shema space', resolvedVenues:['Shema Space'], room:'Shema Space', eventName:'Original', timezone:'Asia/Singapore', startAt:now+5*hour,endAt:now+6*hour,
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
async function args(ctx, extra={}) {
  const view=await requests.view.handler(ctx,{token});
  return {token,version:view.version,sequence:7,scope:'occurrence',kind:'change',message:'Please update',operationKey:crypto.randomUUID(),confirmed:true,
    edit:{room:'Shema Space',startAt:now+7*hour,endAt:now+8*hour,eventName:'New title',purpose:'Meeting',ministry:'Youth'},...extra};
}
async function submitPending(ctx, extra={}) {
  await requests.submit.handler(ctx,await args(ctx,extra));
  const request=ctx.rows('bookingRequests').at(-1);
  const worker=await requests.claim.handler(ctx,{requestId:request._id,token:'worker'});
  if(worker) await requests.checked.handler(ctx,{requestId:request._id,token:'worker',available:true});
  return request._id;
}
async function markPhases(ctx,requestId) {
  await requests.claim.handler(ctx,{requestId,token:'apply'});
  await requests.checked.handler(ctx,{requestId,token:'apply',available:true});
  await requests.savePhase.handler(ctx,{requestId,token:'apply',phase:'delete',targets:[],replacements:[],retained:[]});
}

test('two hour boundary is closed and enforced in milliseconds',()=>{
  const meetings=rules.requestMeetings(booking({occurrences:undefined,startAt:now+2*hour}));
  assert.doesNotThrow(()=>rules.checkRequestWindow(meetings,now-1));
  assert.throws(()=>rules.checkRequestWindow(meetings,now),/two hours/);
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
test('single edit checks availability before entering approval and leaves original unchanged',async()=>{
  const ctx=setup();const before=await ctx.db.get('booking');await requests.submit.handler(ctx,await args(ctx));
  const req=ctx.rows('bookingRequests')[0];assert.equal(req.status,'checking');assert.equal(JSON.parse(req.snapshot).length,1);
  assert.deepEqual(rules.requestMeetings(await ctx.db.get('booking')),rules.requestMeetings(before));assert.ok(ctx.jobs.some(job=>job[1]==='processRequesterOperation'));
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
  await assert.rejects(requests.submit.handler(ctx,{...input,operationKey:crypto.randomUUID()}),/changed/);
});
test('message size and required change description are validated server-side',async()=>{
  for(const message of ['a'.repeat(4001)]) {const ctx=setup();await assert.rejects(requests.submit.handler(ctx,await args(ctx,{message})));}
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
    await assert.rejects(requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId:'x',outcome:'declined',response:'No'}),/Access denied/);
  } finally {delete globalThis.__roomopsActor;}
});
test('approval automatically stages changes, protects claims, and commits only after Calendar verification',async()=>{
  const ctx=setup();const requestId=await submitPending(ctx);const before=await ctx.db.get('booking');
  await requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:'Approved'});
  const staged=await ctx.db.get('booking');assert.deepEqual(staged.occurrences,before.occurrences);
  assert.equal(staged.requesterOperationId,requestId);assert.ok(ctx.rows('bookingClaims').length);
  await markPhases(ctx,requestId);
  await requests.complete.handler(ctx,{requestId,token:'apply',events:[]});
  const saved=await ctx.db.get('booking');assert.equal(saved.occurrences[0].startAt,now+7*hour);assert.equal(saved.occurrences[0].details.eventName,'New title');
  assert.equal(saved.calendarSyncStatus,'synced');assert.equal(saved.requesterOperationId,undefined);
  assert.equal((await ctx.db.get(requestId)).status,'completed');
  assert.ok(ctx.rows('bookingNotices').some(row=>row.requestSubject==='Booking Changes Approved'));
  const count=ctx.rows('bookingNotices').length;
  await requests.complete.handler(ctx,{requestId,token:'apply',events:[]});assert.equal(ctx.rows('bookingNotices').length,count);
});
test('confirmed cancellation bypasses approval and releases only the selected tail after Google cleanup',async()=>{
  const ctx=setup();await requests.submit.handler(ctx,await args(ctx,{kind:'cancel',sequence:3,scope:'following',edit:undefined,message:''}));
  const requestId=ctx.rows('bookingRequests')[0]._id;assert.equal((await ctx.db.get(requestId)).status,'applying');
  await markPhases(ctx,requestId);await requests.complete.handler(ctx,{requestId,token:'apply',events:[]});
  assert.deepEqual((await ctx.db.get('booking')).occurrences.map(row=>row.sequence),[7]);
  assert.ok(ctx.rows('bookingNotices').some(row=>row.requestSubject==='Booking Cancellation Confirmation'));
  assert.equal((await ctx.db.get(requestId)).status,'completed');
});
test('decline records response and email without changing booking; repeat resolution is rejected without duplicate emails',async()=>{
  const ctx=setup();const requestId=await submitPending(ctx);
  const before=await ctx.db.get('booking');const input={expectedRequestRevision:1,requestId,outcome:'declined',response:'Requested room is occupied.'};await requests.resolve.handler(ctx,input);
  assert.deepEqual(rules.requestMeetings(await ctx.db.get('booking')),rules.requestMeetings(before));assert.equal((await requests.view.handler(ctx,{token})).requests[0].response,input.response);
  const count=ctx.rows('bookingNotices').length;await assert.rejects(requests.resolve.handler(ctx,input),/updated/);assert.equal(ctx.rows('bookingNotices').length,count);
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

test('single legacy booking without an occurrences array can request a room and date change',async()=>{
  const ctx=setup({occurrences:undefined});await requests.submit.handler(ctx,await args(ctx,{sequence:0,edit:{room:'Board Room',startAt:now+30*hour,endAt:now+31*hour,eventName:'Moved',purpose:'Updated',ministry:'Office'}}));
  const candidate=JSON.parse(ctx.rows('bookingRequests')[0].candidate);
  assert.equal(candidate.occurrences.length,1);assert.equal(candidate.occurrences[0].room,'Board Room');assert.equal(candidate.startAt,now+30*hour);
});
test('following edits shift all selected meetings and retain earlier overrides',async()=>{
  const ctx=setup({occurrences:[{sequence:1,startAt:now-hour,endAt:now,details:{eventName:'Past'}},{sequence:7,startAt:now+5*hour,endAt:now+6*hour},{sequence:3,startAt:now+24*hour,endAt:now+25*hour}]});
  await requests.submit.handler(ctx,await args(ctx,{scope:'following'}));const next=JSON.parse(ctx.rows('bookingRequests')[0].candidate);
  assert.equal(next.occurrences[0].details.eventName,'Past');assert.equal(next.occurrences[2].startAt,now+26*hour);
  assert.equal(next.occurrences[2].details.eventName,'New title');
});
test('room validation rejects unknown rooms and proposed times inside the cutoff',async()=>{
  for(const patch of [{room:'Invented room'},{startAt:Date.now()+hour,endAt:Date.now()+2*hour}]) {
    const ctx=setup();const input=await args(ctx);await assert.rejects(requests.submit.handler(ctx,{...input,edit:{...input.edit,...patch}}));
  }
});
test('new cancellation requires explicit confirmation',async()=>{
  const ctx=setup();await assert.rejects(requests.submit.handler(ctx,await args(ctx,{kind:'cancel',confirmed:false})),/Confirm/);
});
test('conflict at submission auto-rejects, keeps original, and emails only requester',async()=>{
  const ctx=setup();const before=await ctx.db.get('booking');await ctx.db.insert('bookings',booking({_id:'other'}));
  const {normalizeRoomKey,utcDaysForInterval}=await import('../convex/lib/bookingRules.ts');
  for(const utcDay of utcDaysForInterval(now+7*hour,now+8*hour)) await ctx.db.insert('bookingClaims',{bookingId:'other',roomKey:normalizeRoomKey('Shema Space'),utcDay,startAt:now+7*hour,endAt:now+8*hour});
  // The test DB insert generates its own key; explicitly align the claim with it.
  const other=ctx.rows('bookings').find(row=>row._id!=='booking');for(const claim of ctx.rows('bookingClaims'))claim.bookingId=other._id;
  await requests.submit.handler(ctx,await args(ctx));assert.equal(ctx.rows('bookingRequests')[0].status,'declined');assert.deepEqual(rules.requestMeetings(await ctx.db.get('booking')),rules.requestMeetings(before));
  assert.equal(ctx.rows('bookingNotices').length,1);assert.equal(ctx.rows('bookingNotices')[0].approverNotice,false);
});
test('Google conflict after submission is rejected before the approval queue',async()=>{
  const ctx=setup();await requests.submit.handler(ctx,await args(ctx));const requestId=ctx.rows('bookingRequests')[0]._id;
  await requests.claim.handler(ctx,{requestId,token:'check'});await requests.checked.handler(ctx,{requestId,token:'check',available:false});
  assert.equal((await ctx.db.get(requestId)).status,'declined');assert.equal((await ctx.db.get('booking')).eventName,'Original');
});
test('conflict introduced between request and approval rejects entire recurring edit',async()=>{
  const ctx=setup();const requestId=await submitPending(ctx,{scope:'following'});const before=await ctx.db.get('booking');
  const other=await ctx.db.insert('bookings',{...booking(),_id:undefined});ctx.rows('bookings').at(-1)._id=other;
  const {normalizeRoomKey,utcDaysForInterval}=await import('../convex/lib/bookingRules.ts');
  for(const utcDay of utcDaysForInterval(now+26*hour,now+27*hour))await ctx.db.insert('bookingClaims',{bookingId:other,roomKey:normalizeRoomKey('Shema Space'),utcDay,startAt:now+26*hour,endAt:now+27*hour});
  await requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:''});assert.equal((await ctx.db.get(requestId)).status,'declined');assert.deepEqual(rules.requestMeetings(await ctx.db.get('booking')),rules.requestMeetings(before));
});
test('admin edits while a request awaits review make approval stale',async()=>{
  const ctx=setup();const requestId=await submitPending(ctx);await ctx.db.patch('booking',{revision:4});
  await requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:''});assert.equal((await ctx.db.get(requestId)).status,'declined');
});
test('full cancellation preserves history and private receipt while retaining a read-only booking',async()=>{
  const ctx=setup();await requests.submit.handler(ctx,await args(ctx,{kind:'cancel',scope:'following',edit:undefined}));const requestId=ctx.rows('bookingRequests')[0]._id;
  await markPhases(ctx,requestId);await requests.complete.handler(ctx,{requestId,token:'apply',events:[]});
  assert.equal((await ctx.db.get('booking')).status,'cancelled');assert.equal(ctx.rows('bookingRequests').length,1);assert.equal(ctx.rows('bookingClaims').length,0);
  const receipt=await requests.view.handler(ctx,{token});assert.equal(receipt.meetings.length,0);assert.equal(receipt.requests[0].status,'completed');
  const notice=ctx.rows('bookingNotices').find(row=>row.requestSubject==='Booking Cancellation Confirmation');assert.equal(JSON.parse(notice.outstandingJson).rows.length,0);
});
test('cancellation supersedes a pending edit without entering approver queue',async()=>{
  const ctx=setup();await submitPending(ctx);await requests.submit.handler(ctx,await args(ctx,{kind:'cancel',edit:undefined}));
  assert.deepEqual(ctx.rows('bookingRequests').map(row=>row.status),['declined','applying']);
});
test('expired or stolen worker token cannot commit or clear the booking lock',async()=>{
  const ctx=setup();const requestId=await submitPending(ctx);await requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:''});
  await markPhases(ctx,requestId);await assert.rejects(requests.complete.handler(ctx,{requestId,token:'wrong',events:[]}),/ownership/);
  assert.equal((await ctx.db.get('booking')).requesterOperationId,requestId);
});
test('integration failure keeps original claims and schedule, and never sends success',async()=>{
  const ctx=setup();const requestId=await submitPending(ctx);await requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:''});
  await requests.claim.handler(ctx,{requestId,token:'worker'});await requests.failure.handler(ctx,{requestId,token:'worker'});
  assert.equal((await ctx.db.get('booking')).occurrences[0].startAt,now+5*hour);assert.ok(ctx.rows('bookingClaims').length);
  assert.ok(!ctx.rows('bookingNotices').some(row=>row.requestSubject==='Booking Changes Approved'));assert.ok(ctx.jobs.some(job=>job[0]>0&&job[1]==='processRequesterOperation'));
});
test('booking approver can approve without booking-edit capability; viewer cannot',async()=>{
  const ctx=setup();const requestId=await submitPending(ctx);
  try { globalThis.__roomopsActor={role:'booking_viewer',status:'active',clerkUserId:'viewer'};
    await assert.rejects(requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:''}),/Access denied/);
    globalThis.__roomopsActor={role:'booking_approver',status:'active',clerkUserId:'approver'};
    await requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:''});assert.equal((await ctx.db.get(requestId)).status,'applying');
  }finally{delete globalThis.__roomopsActor;}
});
test('revoked bearer token cannot read or submit',async()=>{
  const ctx=setup();await requests.revokeLink.handler(ctx,{bookingId:'booking'});assert.equal(await requests.view.handler(ctx,{token}),null);
  await assert.rejects(requests.submit.handler(ctx,{token,version:'',sequence:7,scope:'occurrence',kind:'cancel',message:'',operationKey:crypto.randomUUID(),confirmed:true}),/unavailable/);
});

const googleActions = await import('../convex/googleCalendar.ts');
const google = await import('../convex/lib/googleCalendar.ts');
async function googleWorkflow(run, {available=()=>true, failDelete=false}={}) {
  const env={GOOGLE_CALENDAR_ENABLED:'true',GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64:Buffer.from(JSON.stringify({client_email:'test@example.com',private_key:'-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----'})).toString('base64'),GOOGLE_CALENDAR_VENUE_MAP_JSON:JSON.stringify(Object.fromEntries(google.GOOGLE_CALENDAR_VENUES.map((venue,i)=>[venue,`calendar-${i}`])))};
  const oldEnv=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
  const proto=google.GoogleCalendarClient.prototype;
  const names=['listManagedEvents','availableExceptBooking','createEvent','verifyManagedEvent','deleteManagedEvent'];
  const old=Object.fromEntries(names.map(name=>[name,proto[name]]));
  const map=new Map();const calls=[];let deletesFail=failDelete;
  const calendar=venue=>`calendar-${google.GOOGLE_CALENDAR_VENUES.indexOf(venue)}`;
  const refs=[{calendarId:calendar('Shema Space'),eventId:'old-one',targetVenue:'Shema Space',occurrenceSequence:7,startAt:now+5*hour,endAt:now+6*hour},
    {calendarId:calendar('Board Room'),eventId:'old-two',targetVenue:'Board Room',occurrenceSequence:3,startAt:now+24*hour,endAt:now+25*hour}];
  for(const ref of refs)map.set(ref.eventId,ref);
  proto.listManagedEvents=async(_,id)=>[...map.values()].filter(row=>row.calendarId===id);
  proto.availableExceptBooking=async input=>{calls.push(['check',input]);return available(input,calls.filter(row=>row[0]==='check').length);};
  proto.createEvent=async(input,generation)=>{
    const eventId=await google.deterministicGoogleCalendarEventId({bookingId:input.bookingId,calendarId:input.calendarId,venue:input.venue,generation});
    const event={calendarId:input.calendarId,eventId,targetVenue:input.venue,startAt:input.startAt,endAt:input.endAt};map.set(eventId,event);calls.push(['create',event]);return event;
  };
  proto.verifyManagedEvent=async ref=>{assert.ok(map.has(ref.eventId),'Cannot verify missing event');return {eventId:ref.eventId,calendarId:ref.calendarId};};
  proto.deleteManagedEvent=async ref=>{calls.push(['delete',ref]);if(deletesFail)throw Error('Google unavailable');map.delete(ref.eventId);return true;};
  const ctx=setup({calendarEvents:refs});ctx.runMutation=async(name,input)=>{assert.ok(requests[name],`Unknown mutation ${name}`);return requests[name].handler(ctx,input);};
  try {await run({ctx,map,calls,refs,allowDelete:()=>{deletesFail=false;}});}
  finally{for(const name of names)proto[name]=old[name];for(const[key,value]of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
test('Calendar worker checks, queues approval, creates replacements, then deletes only selected events',async()=>{
  await googleWorkflow(async({ctx,map,calls})=>{
    await requests.submit.handler(ctx,await args(ctx));const requestId=ctx.rows('bookingRequests')[0]._id;
    await googleActions.processRequesterOperation.handler(ctx,{requestId});assert.equal((await ctx.db.get(requestId)).status,'pending');assert.equal(calls.filter(row=>row[0]==='create').length,0);
    await requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:''});await googleActions.processRequesterOperation.handler(ctx,{requestId});
    assert.equal((await ctx.db.get(requestId)).status,'completed');assert.ok(map.has('old-two'));assert.ok(!map.has('old-one'));assert.equal(map.size,2);
    assert.ok(calls.findIndex(row=>row[0]==='create')<calls.findIndex(row=>row[0]==='delete'));
  });
});
test('Calendar cancellation runs immediately and never creates an approval task',async()=>{
  await googleWorkflow(async({ctx,map,calls})=>{
    await requests.submit.handler(ctx,await args(ctx,{kind:'cancel',edit:undefined,scope:'following'}));const requestId=ctx.rows('bookingRequests')[0]._id;
    await googleActions.processRequesterOperation.handler(ctx,{requestId});assert.equal((await ctx.db.get(requestId)).status,'completed');assert.equal((await ctx.db.get('booking')).status,'cancelled');assert.equal(map.size,0);
    assert.ok(!ctx.rows('bookingNotices').some(row=>row.requestSubject==='Booking Change Request Requires Approval'));assert.equal(calls.filter(row=>row[0]==='create').length,0);
  });
});
test('Calendar conflict affecting one later recurrence rejects the whole request',async()=>{
  await googleWorkflow(async({ctx,map})=>{
    await requests.submit.handler(ctx,await args(ctx,{scope:'following'}));const requestId=ctx.rows('bookingRequests')[0]._id;
    await googleActions.processRequesterOperation.handler(ctx,{requestId});assert.equal((await ctx.db.get(requestId)).status,'declined');assert.ok(map.has('old-one')&&map.has('old-two'));
    assert.deepEqual((await ctx.db.get('booking')).occurrences,booking().occurrences);
  },{available:input=>input.startAt<now+20*hour});
});
test('Calendar conflict between review and approval preserves original schedule and events',async()=>{
  await googleWorkflow(async({ctx,map})=>{
    await requests.submit.handler(ctx,await args(ctx));const requestId=ctx.rows('bookingRequests')[0]._id;
    await googleActions.processRequesterOperation.handler(ctx,{requestId});await requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:''});
    await googleActions.processRequesterOperation.handler(ctx,{requestId});assert.equal((await ctx.db.get(requestId)).status,'declined');assert.equal((await ctx.db.get('booking')).requesterOperationId,undefined);assert.ok(map.has('old-one'));assert.equal(map.size,2);
  },{available:(_,call)=>call===1});
});
test('last-minute external conflict rolls back replacements without deleting originals',async()=>{
  await googleWorkflow(async({ctx,map,calls})=>{
    await requests.submit.handler(ctx,await args(ctx));const requestId=ctx.rows('bookingRequests')[0]._id;
    await googleActions.processRequesterOperation.handler(ctx,{requestId});await requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:''});
    await googleActions.processRequesterOperation.handler(ctx,{requestId});assert.equal((await ctx.db.get(requestId)).status,'declined');assert.ok(map.has('old-one')&&map.has('old-two'));assert.equal(map.size,2);
    assert.ok(!calls.some(row=>row[0]==='delete'&&row[1].eventId==='old-one'));
  },{available:(_,call)=>call<3});
});
test('Calendar deletion failure resumes recorded phase and sends success only after verified retry',async()=>{
  await googleWorkflow(async({ctx,map,allowDelete})=>{
    await requests.submit.handler(ctx,await args(ctx,{kind:'cancel',edit:undefined}));const requestId=ctx.rows('bookingRequests')[0]._id;
    await googleActions.processRequesterOperation.handler(ctx,{requestId});assert.equal((await ctx.db.get(requestId)).phase,'delete');assert.equal((await ctx.db.get(requestId)).status,'applying');
    assert.ok(await ctx.db.get('booking'));assert.ok(!ctx.rows('bookingNotices').some(row=>row.requestSubject==='Booking Cancellation Confirmation'));
    allowDelete();await googleActions.processRequesterOperation.handler(ctx,{requestId});assert.equal((await ctx.db.get(requestId)).status,'completed');assert.ok(!map.has('old-one'));assert.ok(map.has('old-two'));
    assert.equal(ctx.rows('bookingNotices').filter(row=>row.requestSubject==='Booking Cancellation Confirmation').length,1);
  },{failDelete:true});
});
test('old expired worker cannot recover a newer lease',async()=>{
  const ctx=setup();await requests.submit.handler(ctx,await args(ctx));const requestId=ctx.rows('bookingRequests')[0]._id;
  await requests.claim.handler(ctx,{requestId,token:'new'});await requests.recover.handler(ctx,{requestId,token:'old'});
  assert.equal((await ctx.db.get(requestId)).workerToken,'new');
});
test('approval cannot proceed after the original two-hour deadline',async()=>{
  const ctx=setup();const requestId=await submitPending(ctx);const originalNow=Date.now;
  try {Date.now=()=>now+4*hour;await requests.resolve.handler(ctx,{expectedRequestRevision:1,requestId,outcome:'completed',response:''});assert.equal((await ctx.db.get(requestId)).status,'declined');}
  finally{Date.now=originalNow;}
});

test('additional answers preserve per-occurrence changes without altering other meetings or identity',async()=>{
  const ctx=setup({formResponses:[{qid:'notes',label:'Setup needs',type:'control_textarea',value:'Original chairs'},{qid:'email',label:'Email',canonicalField:'requesterEmail',value:'owner@example.com'}]});
  const input=await args(ctx);input.edit.responses=[{qid:'notes',value:'Ten chairs'}];await requests.submit.handler(ctx,input);
  const candidate=JSON.parse(ctx.rows('bookingRequests')[0].candidate);const meetings=rules.requestMeetings(candidate);
  assert.equal(meetings[0].fields[0].value,'Ten chairs');assert.equal(meetings[1].fields[0].value,'Original chairs');assert.equal(candidate.requesterEmail,'owner@example.com');
  assert.equal(meetings[0].fields.length,1);
});
test('additional answers cannot change canonical contact fields or invent an unknown question',async()=>{
  for(const qid of ['email','unknown']){
    const ctx=setup({formResponses:[{qid:'email',label:'Email',canonicalField:'requesterEmail',value:'owner@example.com'}]});const input=await args(ctx);input.edit.responses=[{qid,value:'thief@example.com'}];
    await assert.rejects(requests.submit.handler(ctx,input),/additional booking field/);
  }
});
test('a retry after full cancellation returns success without creating another receipt',async()=>{
  await googleWorkflow(async({ctx})=>{
    const input=await args(ctx,{kind:'cancel',scope:'following',edit:undefined});await requests.submit.handler(ctx,input);const requestId=ctx.rows('bookingRequests')[0]._id;
    await googleActions.processRequesterOperation.handler(ctx,{requestId});assert.equal((await ctx.db.get('booking')).status,'cancelled');
    const count=ctx.rows('bookingNotices').length;assert.deepEqual(await requests.submit.handler(ctx,input),{submitted:true});assert.equal(ctx.rows('bookingNotices').length,count);
  });
});
test('duplicate idempotency key with a different payload is rejected',async()=>{
  const ctx=setup();const input=await args(ctx);await requests.submit.handler(ctx,input);
  await assert.rejects(requests.submit.handler(ctx,{...input,edit:{...input.edit,eventName:'Something else'}}),/different request/);
});
test('administrator cannot bypass a failed requester operation using ordinary edit or delete controls',async()=>{
  const ctx=setup({requesterOperationId:'request',calendarSyncStatus:'failed'});const bookings=await import('../convex/bookings.ts');
  await assert.rejects(bookings.beginBookingDeletion.handler(ctx,{bookingId:'booking',expectedRevision:0,actorId:'admin',deletionToken:'delete'}),/requester operation/);
  await assert.rejects(bookings.retryCalendarSync.handler(ctx,{bookingId:'booking'}),/requester operation/);
});

const adminBookings = await import('../convex/bookings.ts');
const fields = await import('../shared/requestFields.ts');
const ui = await import('../lib/ui.ts');
async function updateInput(ctx, extra={}) {
  const pending=ctx.rows('bookingRequests').find(row=>row.status==='pending');
  const input=await args(ctx);
  return {...input,expectedRequestKey:pending.operationKey,expectedRequestRevision:pending.requestRevision??1,edit:{...input.edit,eventName:`Updated ${pending.requestRevision??1}`},...extra};
}
async function checkLatest(ctx, id) {
  const worker=await requests.claim.handler(ctx,{requestId:id,token:crypto.randomUUID()});
  if(worker)await requests.checked.handler(ctx,{requestId:id,token:worker.workerToken,available:true});
}
function adminInput(b) {return {...b,bookingId:b._id,expectedRevision:b.revision??0,editScope:'occurrence',occurrenceSequence:7,eventName:'Admin changed title',recurrenceFrequency:'none',recurrenceHasEndDate:false};}

test('pending edits update one row, preserve old versions, enforce lifetime three-edit limit',async()=>{
 const ctx=setup();const id=await submitPending(ctx);const first=structuredClone(ctx.rows('bookingRequests')[0]);
 for(let n=2;n<=3;n++) {const input=await updateInput(ctx);await requests.submit.handler(ctx,input);await requests.submit.handler(ctx,input);await checkLatest(ctx,id);assert.equal(ctx.rows('bookingRequests').length,1);assert.equal((await ctx.db.get('booking')).requesterEditCount,n);}
 const latest=await ctx.db.get(id);assert.equal(latest.requestRevision,3);assert.equal(latest.revisions.length,2);assert.equal(latest.revisions[0].proposal,first.proposal);
 await assert.rejects(requests.submit.handler(ctx,await updateInput(ctx)),/maximum of 3/);
 await requests.resolve.handler(ctx,{requestId:id,expectedRequestRevision:3,outcome:'declined',response:'Not available'});
 await assert.rejects(requests.submit.handler(ctx,await args(ctx)),/maximum of 3/);
 await requests.submit.handler(ctx,await args(ctx,{kind:'cancel',edit:undefined}));
 assert.equal((await ctx.db.get('booking')).requesterEditCount,3);
});
test('legacy request history contributes to lifetime count',async()=>{
 const ctx=setup();for(let i=0;i<3;i++)await ctx.db.insert('bookingRequests',{bookingId:'booking',kind:'change',status:'declined',createdAt:now+i});
 await assert.rejects(requests.submit.handler(ctx,await args(ctx)),/maximum of 3/);
});
test('old operation retry after pending update is idempotent, not a new edit',async()=>{
 const ctx=setup();const input=await args(ctx);await requests.submit.handler(ctx,input);const id=ctx.rows('bookingRequests')[0]._id;await checkLatest(ctx,id);
 await requests.submit.handler(ctx,await updateInput(ctx));await requests.submit.handler(ctx,input);
 assert.equal((await ctx.db.get('booking')).requesterEditCount,2);assert.equal((await ctx.db.get(id)).requestRevision,2);
});
test('stale approver cannot approve or reject a newly updated request',async()=>{
 const ctx=setup();const id=await submitPending(ctx);await requests.submit.handler(ctx,await updateInput(ctx));await checkLatest(ctx,id);
 for(const outcome of ['completed','declined']) await assert.rejects(requests.resolve.handler(ctx,{requestId:id,expectedRequestRevision:1,outcome,response:''}),/updated/);
 assert.equal((await ctx.db.get(id)).status,'pending');
 await requests.resolve.handler(ctx,{requestId:id,expectedRequestRevision:2,outcome:'completed',response:''});assert.equal((await ctx.db.get(id)).status,'applying');
});
test('approval first blocks a previously opened pending edit and cancellation',async()=>{
 const ctx=setup();const id=await submitPending(ctx);const update=await updateInput(ctx);const cancel=await args(ctx,{kind:'cancel',edit:undefined});
 await requests.resolve.handler(ctx,{requestId:id,expectedRequestRevision:1,outcome:'completed',response:''});
 for(const input of [update,cancel])await assert.rejects(requests.submit.handler(ctx,input),/updated|changed/);
});
test('requester edit versus requester cancellation: first committed snapshot wins in both orders',async()=>{
 for(const first of ['change','cancel']) {const ctx=setup();const edit=await args(ctx);const cancel=await args(ctx,{kind:'cancel',edit:undefined});await requests.submit.handler(ctx,first==='change'?edit:cancel);await assert.rejects(requests.submit.handler(ctx,first==='change'?cancel:edit),/changed|updated/);assert.equal(ctx.rows('bookingRequests').length,1);}
});
test('requester intent makes existing admin edit and deletion snapshots stale',async()=>{
 for(const kind of ['change','cancel']) {const ctx=setup();const before=await ctx.db.get('booking');await requests.submit.handler(ctx,await args(ctx,{kind,edit:kind==='cancel'?undefined:(await args(ctx)).edit}));
 await assert.rejects(adminBookings.edit.handler(ctx,adminInput(before)),/changed|requester operation/);
 await assert.rejects(adminBookings.beginBookingDeletion.handler(ctx,{bookingId:'booking',expectedRevision:0,actorId:'admin',deletionToken:'delete'}),/changed|requester operation/);}
});
test('admin edit or cancellation first rejects stale requester submissions',async()=>{
 for(const action of ['edit','cancel'])for(const kind of ['change','cancel']){const ctx=setup();const input=await args(ctx,{kind,edit:kind==='cancel'?undefined:(await args(ctx)).edit});const before=await ctx.db.get('booking');
 if(action==='edit')await adminBookings.edit.handler(ctx,adminInput(before));else await adminBookings.beginBookingDeletion.handler(ctx,{bookingId:'booking',expectedRevision:0,actorId:'admin',deletionToken:'delete'});
 await assert.rejects(requests.submit.handler(ctx,input),/changed|updated/);assert.equal(ctx.rows('bookingRequests').length,0);}
});
test('approval first blocks direct admin edit and deletion snapshots',async()=>{
 const ctx=setup();const id=await submitPending(ctx);const before=await ctx.db.get('booking');await requests.resolve.handler(ctx,{requestId:id,expectedRequestRevision:1,outcome:'completed',response:''});
 await assert.rejects(adminBookings.edit.handler(ctx,adminInput(before)),/requester operation/);
 await assert.rejects(adminBookings.beginBookingDeletion.handler(ctx,{bookingId:'booking',expectedRevision:before.revision,actorId:'admin',deletionToken:'delete'}),/requester operation/);
});
test('admin edit versus cancellation reject the second stale snapshot in both orders',async()=>{
 for(const first of ['edit','cancel']){const ctx=setup();const b=await ctx.db.get('booking');const remove=()=>adminBookings.beginBookingDeletion.handler(ctx,{bookingId:'booking',expectedRevision:0,actorId:'admin',deletionToken:'delete'});const edit=()=>adminBookings.edit.handler(ctx,adminInput(b));await(first==='edit'?edit():remove());await assert.rejects(first==='edit'?remove():edit());}
});
test('ministry validation rejects arbitrary values and safely handles missing configuration',async()=>{
 const ctx=setup({ministry:'Legacy value'});const input=await args(ctx);await assert.rejects(requests.submit.handler(ctx,{...input,edit:{...input.edit,ministry:'Testing'}}),/Select a ministry/);
 const saved=process.env.BOOKING_MINISTRIES_JSON;try{process.env.BOOKING_MINISTRIES_JSON='bad json';assert.deepEqual((await requests.view.handler(ctx,{token})).ministries,[]);await assert.rejects(requests.submit.handler(ctx,input),/not available/);}finally{process.env.BOOKING_MINISTRIES_JSON=saved;}
 await requests.submit.handler(ctx,input);assert.equal((await ctx.db.get('booking')).requesterEditCount,1);
});
test('phone format handles legacy Jotform values, rejects invalid numbers and normalizes',async()=>{
 assert.equal(fields.normalizePhone('full: (65) 8123 4567'),'(65) 8123 4567');assert.equal(fields.normalizePhone('+65 81234567'),'(65) 8123 4567');assert.equal(fields.phoneInput('(65) 8'),'(65) 8');
 for(const [input,expected] of [['+44 20 7946 0958','+44 20 7946 0958'],['+1-415-555-0132','+1 415 555 0132'],['(61) 2 5550 1234','(61) 2 5550 1234'],['+442079460958','+442079460958']])assert.equal(fields.normalizePhone(input),expected);
 for(const bad of ['abc','2423 4342','123','8123 45670','+65 1234 5678','(65) 1234 5678','+44 123','+0 2079460958','+1 415 555 0132 99999','12ab34 5678'])assert.throws(()=>fields.normalizePhone(bad),/valid phone number/);
 assert.equal(fields.phoneForEdit('81234567'),'(65) 8123 4567');assert.equal(fields.phoneForEdit('full: 12'),'12');
 const ctx=setup({formResponses:[{qid:'phone',label:'Phone Number',type:'control_phone',value:'full: (65) 8123 4567'}]});const input=await args(ctx);
 await assert.rejects(requests.submit.handler(ctx,{...input,edit:{...input.edit,responses:[{qid:'phone',value:'bad'}]}}),/valid phone number/);
 await requests.submit.handler(ctx,{...input,edit:{...input.edit,responses:[{qid:'phone',value:'81234567'}]}});
 assert.equal(JSON.parse(ctx.rows('bookingRequests')[0].candidate).occurrences[0].details.responses[0].value,'(65) 8123 4567');
});
test('duration is never exposed or accepted as a requester editable field',async()=>{
 const ctx=setup({formResponses:[{qid:'duration',label:'Duration (hours)',type:'control_number',value:'1.2'}]});assert.deepEqual((await requests.view.handler(ctx,{token})).meetings[0].fields,[]);const input=await args(ctx);
 await assert.rejects(requests.submit.handler(ctx,{...input,edit:{...input.edit,responses:[{qid:'duration',value:'99'}]}}),/invalid/);
});
test('friendly errors preserve natural at phrases and remove Convex diagnostics',()=>{
 const text='Change at least one booking detail before submitting.';assert.equal(ui.messageFromError(new Error(text)),text);
 assert.equal(ui.messageFromError(new Error('[CONVEX M(bookingRequests:submit)] [Request ID: abc] Server Error Uncaught ConvexError: '+text)),text);
 assert.doesNotMatch(ui.messageFromError(new Error('[CONVEX M(x)] [Request ID: abc] Server Error')),/CONVEX|Request ID|Server Error/);
 assert.match(ui.messageFromError({data:{code:'BOOKING_EDIT_CONFLICT',message:'The booking changed.'}}),/review the latest/i);
});
test('admin comments are audited and included in scoped cancellation notice',async()=>{
 const ctx=setup({status:'pending'});await adminBookings.removeOccurrences.handler(ctx,{bookingId:'booking',expectedRevision:0,scope:'occurrence',occurrenceSequence:3,notifySubmitter:true,reason:'Room needed for church event'});
 assert.match(ctx.rows('bookingNotices')[0].detailChanges,/Room needed for church event/);assert.ok(ctx.rows('auditLogs').some(row=>row.detailsJson?.includes('Room needed for church event')));
});
test('admin edit comment reaches audit and email',async()=>{
 const ctx=setup();const b=await ctx.db.get('booking');await adminBookings.edit.handler(ctx,{...adminInput(b),notifySubmitter:true,reason:'Meeting moved by office'});
 assert.match(ctx.rows('bookingNotices')[0].detailChanges,/Meeting moved by office/);assert.ok(ctx.rows('auditLogs').some(row=>row.detailsJson?.includes('Meeting moved by office')));
});
test('full deletion comment is retained on the cancelled booking',async()=>{
 const ctx=setup();await adminBookings.beginBookingDeletion.handler(ctx,{bookingId:'booking',expectedRevision:0,actorId:'admin',deletionToken:'delete'});
 await adminBookings.completeBookingDeletion.handler(ctx,{bookingId:'booking',actorId:'admin',deletionToken:'delete',notifySubmitter:true,reason:'Venue closed'});
 assert.equal((await ctx.db.get('booking')).status,'cancelled');assert.match(ctx.rows('bookingNotices')[0].detailChanges,/Venue closed/);assert.ok(ctx.rows('auditLogs').some(row=>row.detailsJson?.includes('Venue closed')));
});
test('international phone numbers are accepted and stored as entered',async()=>{
 const ctx=setup({formResponses:[{qid:'phone',label:'Phone Number',type:'control_phone',value:'full: (65) 8123 4567'}]});const input=await args(ctx);
 await requests.submit.handler(ctx,{...input,edit:{...input.edit,responses:[{qid:'phone',value:'+44 20 7946 0958'}]}});
 assert.equal(JSON.parse(ctx.rows('bookingRequests')[0].candidate).occurrences[0].details.responses[0].value,'+44 20 7946 0958');
});
test('calendar ministry label drops the Others (Please Specify) prefix only',()=>{
 assert.equal(fields.ministryCalendarLabel('Others (Please Specify): testing'),'testing');
 assert.equal(fields.ministryCalendarLabel('Youth Ministry'),'Youth Ministry');
 assert.equal(fields.ministryCalendarLabel('Others (Please Specify)'),'Others (Please Specify)');
 assert.equal(fields.ministryCalendarLabel(''),'');
});
test('invalid omitted phone cannot bypass validation and retries preserve payload identity',async()=>{
 const ctx=setup({formResponses:[{qid:'phone',label:'Phone',type:'control_phone',value:'full: (65) 2423 4342'}]});const input=await args(ctx);
 await assert.rejects(requests.submit.handler(ctx,input),/valid phone number/);
 const valid={...input,edit:{...input.edit,responses:[{qid:'phone',value:'81234567'}]}};await requests.submit.handler(ctx,valid);await requests.submit.handler(ctx,valid);
 assert.equal(valid.edit.responses[0].value,'81234567');assert.equal((await ctx.db.get('booking')).requesterEditCount,1);
});
test('rejection comment is included in the durable requester email',async()=>{
 const ctx=setup();const id=await submitPending(ctx);await requests.resolve.handler(ctx,{requestId:id,expectedRequestRevision:1,outcome:'declined',response:'Room is reserved for another ministry.'});
 const email=ctx.rows('bookingNotices').find(row=>row.requestSubject==='Booking Changes Not Approved');assert.match(email.detailChanges,/Room is reserved for another ministry/);assert.match(email.requestText,/original booking remains unchanged/);
});
test('admin cancellation after completed requester cancellation fails gracefully without double deletion',async()=>{
 const ctx=setup();await requests.submit.handler(ctx,await args(ctx,{kind:'cancel',scope:'following',edit:undefined}));const id=ctx.rows('bookingRequests')[0]._id;await markPhases(ctx,id);await requests.complete.handler(ctx,{requestId:id,token:'apply',events:[]});
 const count=ctx.rows('bookingNotices').length;await assert.rejects(adminBookings.beginBookingDeletion.handler(ctx,{bookingId:'booking',expectedRevision:0,actorId:'admin',deletionToken:'second'}),/is cancelled/);assert.equal(ctx.rows('bookingNotices').length,count);
});

test('other ministry requires a bounded name and cannot bypass configured choices',async()=>{
 const previous=process.env.BOOKING_MINISTRIES_JSON;
 try {
  process.env.BOOKING_MINISTRIES_JSON=JSON.stringify(['Youth','Others (Please Specify)']);
  for(const otherMinistry of [undefined,'','   ','x'.repeat(121),'Line\nbreak']){
   const ctx=setup();const input=await args(ctx);await assert.rejects(requests.submit.handler(ctx,{...input,edit:{...input.edit,ministry:'Others (Please Specify)',otherMinistry}}),/Specify your ministry/);
   assert.equal(ctx.rows('bookingRequests').length,0);
  }
  process.env.BOOKING_MINISTRIES_JSON='["Youth"]';const ctx=setup();const input=await args(ctx);
  await assert.rejects(requests.submit.handler(ctx,{...input,edit:{...input.edit,ministry:'Others (Please Specify)',otherMinistry:'Test ministry'}}),/Select a ministry/);
 } finally {process.env.BOOKING_MINISTRIES_JSON=previous;}
});
test('specified ministry survives review, pending update, approval and email snapshots',async()=>{
 const previous=process.env.BOOKING_MINISTRIES_JSON;
 try {
  process.env.BOOKING_MINISTRIES_JSON=JSON.stringify(['Youth','Others (Please Specify)']);
  const ctx=setup();const input=await args(ctx);input.edit={...input.edit,ministry:'Others (Please Specify)',otherMinistry:'  Special Ministry  '};
  await requests.submit.handler(ctx,input);const id=ctx.rows('bookingRequests')[0]._id;await checkLatest(ctx,id);
  let row=await ctx.db.get(id);assert.equal(JSON.parse(row.candidate).occurrences[0].details.ministry,'Others (Please Specify): Special Ministry');
  assert.match(ctx.rows('bookingNotices')[0].detailChanges,/Special Ministry/);
  const next=await updateInput(ctx);next.edit={...next.edit,ministry:'Others (Please Specify)',otherMinistry:'Updated Ministry'};
  await requests.submit.handler(ctx,next);await checkLatest(ctx,id);
  await requests.resolve.handler(ctx,{requestId:id,expectedRequestRevision:2,outcome:'completed',response:''});await markPhases(ctx,id);await requests.complete.handler(ctx,{requestId:id,token:'apply',events:[]});
  const meeting=(await requests.view.handler(ctx,{token})).meetings[0];assert.equal(meeting.ministry,'Others (Please Specify): Updated Ministry');
  assert.deepEqual(fields.ministrySelection(meeting.ministry),{ministry:'Others (Please Specify)',otherMinistry:'Updated Ministry'});
  assert.ok(ctx.rows('bookingNotices').some(notice=>notice.requestSubject==='Booking Changes Approved' && notice.detailChanges.includes('Updated Ministry')));
 } finally {process.env.BOOKING_MINISTRIES_JSON=previous;}
});
test('standard ministry choices ignore stale other text',()=>{
 assert.equal(fields.ministryDisplay('Youth','Old custom ministry'),'Youth');
 assert.deepEqual(fields.ministrySelection('Youth'),{ministry:'Youth',otherMinistry:''});
 assert.equal(fields.ministryDisplay('Others (Please Specify)',' New ministry '),'Others (Please Specify): New ministry');
});
