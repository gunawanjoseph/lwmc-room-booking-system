import './roomops-regression-hooks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { GoogleCalendarClient } = await import('../convex/lib/googleCalendar.ts');
const { partitionManagedEventsForFutureReplacement } = await import('../convex/lib/bookingEdit.ts');
const bookings = await import('../convex/bookings.ts');
const actions = await import('../convex/googleCalendar.ts');
const ref = {bookingId:'booking',calendarId:'calendar',eventId:'event',venue:'Shema Space'};
const owned = {id:'event',etag:'"v1"',status:'confirmed',extendedProperties:{private:{roomopsManaged:'true',roomopsBookingId:'booking',roomopsTargetVenue:'Shema Space'}}};
const json = (body,status=200)=>new Response(JSON.stringify(body),{status});
function client(responses) {
  const calls=[];
  const client=new GoogleCalendarClient({credentials:{}, maxAttempts:1,fetch:async(url,init)=>{
    calls.push({url,init});
    assert.ok(responses.length,'Unexpected HTTP request');
    return responses.shift();
  }});
  client.accessToken={value:'fake',expiresAt:Date.now()+3600000};
  return {client,calls};
}
test('retry accepts a metadata-free cancelled tombstone without DELETE',async()=>{
  const c=client([json({id:'event',status:'cancelled'})]);
  assert.equal(await c.client.deleteManagedEvent(ref),false);
  assert.equal(c.calls.length,1);
});
test('owned live event uses ETag and verifies cancellation',async()=>{
  const c=client([json(owned),new Response(null,{status:204}),json({id:'event',status:'cancelled'})]);
  assert.equal(await c.client.deleteManagedEvent(ref),true);
  assert.equal(c.calls[1].init.headers['if-match'],'"v1"');
  assert.deepEqual(c.calls.map(c=>c.init.method),['GET','DELETE','GET']);
});
test('a successful DELETE response with a still-live event fails closed',async()=>{
  const c=client([json(owned),new Response(null,{status:204}),json(owned)]);
  await assert.rejects(c.client.deleteManagedEvent(ref),/DELETE_UNVERIFIED/);
});
test('ownership mismatch is never deleted',async()=>{
  const c=client([json({...owned,extendedProperties:{private:{roomopsBookingId:'other'}}})]);
  await assert.rejects(c.client.deleteManagedEvent(ref),/COLLISION/);
  assert.equal(c.calls.length,1);
});
test('ETag conflict retains the booking for retry',async()=>{
  const c=client([json(owned),json({error:{message:'changed'}},412)]);
  await assert.rejects(c.client.deleteManagedEvent(ref),/DELETE_FAILED/);
});
test('discovery paginates without expanding or date-limiting a recurring parent',async()=>{
  const c=client([json({accessRole:'writer',items:[owned],nextPageToken:'page2'}),json({accessRole:'owner',items:[{...owned,id:'recurring-parent'}]})]);
  assert.deepEqual((await c.client.listManagedEvents('booking','calendar')).map(x=>x.eventId),['event','recurring-parent']);
  const query=new URL(c.calls[1].url).searchParams;
  assert.equal(query.get('singleEvents'),'false');
  assert.equal(query.get('pageToken'),'page2');
  assert.equal(query.get('privateExtendedProperty'),'roomopsBookingId=booking');
  assert.equal(query.has('timeMin'),false);
});
test('discovery rejects lost access, wrong ownership, and repeated pagination',async()=>{
  await assert.rejects(client([json({accessRole:'reader',items:[]})]).client.listManagedEvents('booking','calendar'),/DISCOVERY_FAILED/);
  await assert.rejects(client([json({accessRole:'writer',items:[{id:'alien'}]})]).client.listManagedEvents('booking','calendar'),/DISCOVERY_FAILED/);
  await assert.rejects(client([json({accessRole:'writer',nextPageToken:'x'}),json({accessRole:'writer',nextPageToken:'x'})]).client.listManagedEvents('booking','calendar'),/pagination/);
});
test('running meetings are reconciled, completed events retained',()=>{
  const events=[{startAt:10,endAt:90},{startAt:10,endAt:110},{startAt:101,endAt:150},{}];
  assert.deepEqual(partitionManagedEventsForFutureReplacement(events,100),{keep:[events[0]],replace:events.slice(1)});
});
function dbContext(booking) {
  const scheduled=[];const logs=[];
  return {scheduled,logs, db:{query:()=>({withIndex:()=>({take:async()=>[]})}),get:async()=>booking,patch:async(_,patch)=>Object.assign(booking,patch),insert:async(_,row)=>logs.push(row)},scheduler:{runAfter:async(...args)=>scheduled.push(args)}};
}
test('metadata-only series edit preserves all occurrence time/venue exceptions',async()=>{
  const savedEnv=process.env.GOOGLE_CALENDAR_ENABLED;
  process.env.GOOGLE_CALENDAR_ENABLED='true';
  try {
    const b={_id:'booking',jotformSubmissionId:'s1',status:'approved',revision:2,room:'Shema Space',roomKey:'shema space',startAt:100,endAt:200,timezone:'Asia/Singapore',requesterName:'Person',requesterEmail:'person@example.com',eventName:'Old',recurrenceFrequency:'weekly_same_day',recurrenceHasEndDate:false,occurrences:[{sequence:0,startAt:300,endAt:400,room:'Board Room',resolvedVenues:['Board Room']},{sequence:1,startAt:600,endAt:700}],resolvedVenues:['Shema Space']};
    const before=structuredClone(b.occurrences);const ctx=dbContext(b);
    await bookings.edit.handler(ctx,{...b,bookingId:b._id,expectedRevision:2,eventName:'New',editScope:'series'});
    assert.deepEqual(b.occurrences,before);
    assert.equal(b.eventName,'New');
    assert.equal(b.calendarSyncStatus,'creating');
    assert.ok(ctx.scheduled.some(x=>x[1]==='reconcileApprovedBooking'));
  } finally {if(savedEnv===undefined)delete process.env.GOOGLE_CALENDAR_ENABLED;else process.env.GOOGLE_CALENDAR_ENABLED=savedEnv;}
});
test('legacy deletion endpoint requires Calendar action even without references',async()=>{
  await assert.rejects(bookings.deleteTableRow.handler({},{}),/Refresh RoomOps/);
});
test('discovered deletion targets persist only with a live owning lease',async()=>{
  const b={_id:'booking',deletionToken:'token',deletionLeaseExpiresAt:Date.now()+60000};
  const ctx=dbContext(b);const events=[{calendarId:'c',eventId:'e',targetVenue:'Shema Space'}];
  await bookings.recordBookingDeletionTargets.handler(ctx,{bookingId:'booking',deletionToken:'token',events});
  assert.deepEqual(b.calendarAttemptedEvents,events);
  await assert.rejects(bookings.recordBookingDeletionTargets.handler(ctx,{bookingId:'booking',deletionToken:'other',events}),/no longer owns/);
});
test('empty reconciliation succeeds only when no ongoing/future occurrence remains',async()=>{
  for (const future of [false,true]) {
    const b={_id:'booking',status:'approved',revision:2,calendarSyncToken:'token',occurrences:[{endAt:Date.now()+(future?60000:-60000)}]};
    await bookings.recordCalendarReconcileResult.handler(dbContext(b),{bookingId:'booking',expectedRevision:2,syncToken:'token',success:true,events:[]});
    assert.equal(b.calendarSyncStatus,future?'failed':'synced');
  }
});
test('delete action never finalizes an approved booking when Calendar is disabled',async()=>{
  const saved=process.env.GOOGLE_CALENDAR_ENABLED;process.env.GOOGLE_CALENDAR_ENABLED='false';
  try {
    const calls=[];const b={_id:'booking',status:'approved'};
    const ctx={runMutation:async(name)=>{calls.push(name);if(name==='beginBookingDeletion')return {booking:b,events:[]};},runQuery:async()=>b};
    await assert.rejects(actions.deleteBooking.handler(ctx,{bookingId:'booking',expectedRevision:0}),/kept/);
    assert.equal(calls.includes('completeBookingDeletion'),false);
    assert.equal(calls.includes('failBookingDeletion'),true);
  } finally {if(saved===undefined)delete process.env.GOOGLE_CALENDAR_ENABLED;else process.env.GOOGLE_CALENDAR_ENABLED=saved;}
});
async function withCalendar(methods, run) {
  const {GOOGLE_CALENDAR_VENUES}=await import('../convex/lib/googleCalendar.ts');
  const env={GOOGLE_CALENDAR_ENABLED:'true',GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64:Buffer.from(JSON.stringify({client_email:'test@example.com',private_key:'-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----'})).toString('base64'),GOOGLE_CALENDAR_VENUE_MAP_JSON:JSON.stringify(Object.fromEntries(GOOGLE_CALENDAR_VENUES.map((v,i)=>[v,`calendar-${i}`])))};
  const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
  const originals={};Object.assign(process.env,env);
  for(const [name,method] of Object.entries(methods)){originals[name]=GoogleCalendarClient.prototype[name];GoogleCalendarClient.prototype[name]=method;}
  try {await run();} finally {
    Object.assign(GoogleCalendarClient.prototype,originals);
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
}
test('delete discovers a lost series reference, persists it, removes it, then finalizes',async()=>{
  const events=[{calendarId:'calendar-0',eventId:'lost-parent',targetVenue:'Shema Space'}];
  const calls=[];let exists=true;
  await withCalendar({listManagedEvents:async(_,id)=>id==='calendar-0'&&exists?events:[],deleteManagedEvent:async()=>{calls.push('google-delete');exists=false;return true;}},async()=>{
    const ctx={runMutation:async(name,args)=>{calls.push(name);if(name==='beginBookingDeletion')return {booking:{_id:'booking',status:'approved'},events:[]};if(name==='recordBookingDeletionTargets')assert.deepEqual(args.events,events);if(name==='completeBookingDeletion')return {deleted:true};},runQuery:async()=>({_id:'booking'})};
    assert.deepEqual(await actions.deleteBooking.handler(ctx,{bookingId:'booking',expectedRevision:0}),{deleted:true});
    assert.deepEqual(calls,['beginBookingDeletion','recordBookingDeletionTargets','google-delete','completeBookingDeletion']);
  });
});
test('delete retains the DB row if final discovery still finds a managed event',async()=>{
  const calls=[];const events=[{calendarId:'calendar-0',eventId:'live',targetVenue:'Shema Space'}];
  await withCalendar({listManagedEvents:async(_,id)=>id==='calendar-0'?events:[],deleteManagedEvent:async()=>true},async()=>{
    const ctx={runMutation:async(name)=>{calls.push(name);if(name==='beginBookingDeletion')return {booking:{_id:'booking',status:'approved'},events:[]};},runQuery:async()=>({_id:'booking'})};
    await assert.rejects(actions.deleteBooking.handler(ctx,{bookingId:'booking',expectedRevision:0}),/kept/);
    assert.equal(calls.includes('completeBookingDeletion'),false);
    assert.equal(calls.includes('failBookingDeletion'),true);
  });
});
test('shortening a series to the past cleans obsolete future events before success',async()=>{
  const now=Date.now();const event={calendarId:'calendar-0',eventId:'obsolete',targetVenue:'Shema Space',startAt:now+60000,endAt:now+120000};
  const b={_id:'booking',status:'approved',room:'Shema Space',requesterName:'Person',timezone:'Asia/Singapore',occurrences:[{sequence:0,startAt:now-120000,endAt:now-60000}],calendarEvents:[event]};
  const calls=[];
  await withCalendar({listManagedEvents:async()=>[],deleteManagedEvent:async()=>{calls.push('delete');return true;},createEvent:async(input)=>({calendarId:input.calendarId,eventId:'history'}),verifyManagedEvent:async(input)=>({calendarId:input.calendarId,eventId:input.eventId})},async()=>{
    const ctx={runMutation:async(name,args)=>{if(name==='renewCalendarReconciliationLease')return b;if(name==='recordCalendarReconciliationTargets')return args.events;if(name==='recordCalendarReconcileResult'){assert.equal(args.success,true);assert.equal(args.events.length,1);assert.equal(args.events[0].eventId,'history');calls.push('complete');}}};
    await actions.reconcileApprovedBooking.handler(ctx,{bookingId:'booking',expectedRevision:1,syncToken:'t'});
    assert.deepEqual(calls,['delete','complete']);
  });
});
test('reconciliation repairs missing references and includes an ongoing meeting',async()=>{
  const now=Date.now();const b={_id:'booking',status:'approved',room:'Shema Space',requesterName:'Person',timezone:'Asia/Singapore',occurrences:[{sequence:0,startAt:now-60000,endAt:now+60000}]};
  const calls=[];
  await withCalendar({listManagedEvents:async()=>[],checkAvailability:async(input)=>{assert.equal(input.occurrences.length,1);return {available:true,conflicts:[]};},createEvent:async(input)=>{calls.push('create');assert.equal(input.startAt,b.occurrences[0].startAt);return {calendarId:input.calendarId,eventId:'new'};},verifyManagedEvent:async(input)=>({calendarId:input.calendarId,eventId:input.eventId})},async()=>{
    const ctx={runMutation:async(name,args)=>{if(name==='renewCalendarReconciliationLease')return b;if(name==='recordCalendarReconciliationTargets')return args.events;if(name==='recordCalendarReconcileResult'){assert.equal(args.success,true);assert.equal(args.events.length,1);calls.push('complete');}}};
    await actions.reconcileApprovedBooking.handler(ctx,{bookingId:'booking',expectedRevision:1,syncToken:'t'});
    assert.deepEqual(calls,['create','complete']);
  });
});
test('series end-date preview preserves existing exceptions when shortening',async()=>{
  const now=Date.now();
  const b={_id:'booking',status:'approved',revision:1,room:'Shema Space',roomKey:'shema space',startAt:now-200000,endAt:now-190000,recurrenceFrequency:'weekly_same_day',recurrenceHasEndDate:false,occurrences:[{sequence:0,startAt:now-200000,endAt:now-190000,room:'Board Room'},{sequence:1,startAt:now+200000,endAt:now+210000}]};
  const chain={withIndex:()=>chain,filter:()=>chain,collect:async()=>[]};
  const ctx={db:{get:async()=>b,query:()=>chain}};
  const result=await bookings.previewEdit.handler(ctx,{...b,bookingId:'booking',expectedRevision:1,editScope:'series',recurrenceHasEndDate:true,recurrenceUntilAt:now});
  assert.deepEqual(result,{conflicts:[]});
});
test('reconciliation rebuilds only retained meetings and uses their scoped titles',async()=>{
  const now=Date.now();const b={_id:'booking',status:'approved',room:'Shema Space',eventName:'Base title',requesterName:'Person',timezone:'Asia/Singapore',occurrences:[{sequence:0,startAt:now-120000,endAt:now-60000},{sequence:2,startAt:now+60000,endAt:now+120000,room:'Board Room',details:{eventName:'Only later'}}],calendarEvents:[{calendarId:'calendar-0',eventId:'old-series',targetVenue:'Shema Space'}]};
  const titles=[];let removed=false;
  await withCalendar({listManagedEvents:async()=>[],deleteManagedEvent:async()=>{removed=true;return true;},checkAvailability:async()=>({available:true,conflicts:[]}),createEvent:async(input)=>{assert.ok(removed);titles.push(input.summary);return {calendarId:input.calendarId,eventId:`new-${titles.length}`};},verifyManagedEvent:async(input)=>({calendarId:input.calendarId,eventId:input.eventId})},async()=>{
    const ctx={runMutation:async(name,args)=>{if(name==='renewCalendarReconciliationLease')return b;if(name==='recordCalendarReconciliationTargets')return args.events;if(name==='recordCalendarReconcileResult'){assert.equal(args.success,true);assert.equal(args.events.length,2);}}};
    await actions.reconcileApprovedBooking.handler(ctx,{bookingId:'booking',expectedRevision:1,syncToken:'scope'});
    assert.match(titles[0],/Base title/);assert.match(titles[1],/Only later/);assert.match(titles[1],/Board Room/);assert.equal(titles.length,2);
  });
});

test('edit availability excludes verified own events and expanded owned recurrence',async()=>{
  const c=client([json({accessRole:'writer',items:[owned]}),json({accessRole:'writer',items:[owned,{id:'instance',recurringEventId:'event'}]})]);
  assert.equal(await c.client.availableExceptBooking({calendarId:'calendar',bookingId:'booking',startAt:Date.now(),endAt:Date.now()+3600000,timeZone:'Asia/Singapore'}),true);
  assert.match(c.calls[1].url,/singleEvents=true/);
});
test('edit availability checks all pages and blocks an external recurring/private event',async()=>{
  const c=client([json({accessRole:'owner',items:[owned]}),json({accessRole:'owner',items:[owned],nextPageToken:'two'}),json({accessRole:'owner',items:[{id:'private-instance',recurringEventId:'external'}]})]);
  assert.equal(await c.client.availableExceptBooking({calendarId:'calendar',bookingId:'booking',startAt:Date.now(),endAt:Date.now()+3600000,timeZone:'Asia/Singapore'}),false);
  assert.match(c.calls[2].url,/pageToken=two/);
});
test('transparent and cancelled calendar entries do not block requester edits',async()=>{
  const c=client([json({accessRole:'writer',items:[]}),json({accessRole:'writer',items:[{id:'free',transparency:'transparent'},{id:'gone',status:'cancelled'}]})]);
  assert.equal(await c.client.availableExceptBooking({calendarId:'calendar',bookingId:'booking',startAt:Date.now(),endAt:Date.now()+3600000,timeZone:'Asia/Singapore'}),true);
});
test('availability fails closed on partial permissions or missing Calendar access',async()=>{
  const c=client([json({accessRole:'reader',items:[]})]);
  await assert.rejects(c.client.availableExceptBooking({calendarId:'calendar',bookingId:'booking',startAt:Date.now(),endAt:Date.now()+3600000,timeZone:'Asia/Singapore'}),/write access/);
});
