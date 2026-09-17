import './roomops-regression-hooks.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {scopedSequences,editScopedOccurrences}=await import('../convex/lib/recurrenceScope.ts');
const {writeAuditLog,needsSupportAlert}=await import('../convex/lib/auditLog.ts');
const bookings=await import('../convex/bookings.ts');
const support=await import('../convex/techSupport.ts');
process.env.DEVELOPER_EMAIL='a@example.com';
const now=Date.now();
const occurrences=[0,1,2].map(sequence=>({sequence,startAt:now+86400000*(sequence+1),endAt:now+86400000*(sequence+1)+3600000}));
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
        withIndex:(_,fn)=>{const range={eq:(key,value)=>{selected=selected.filter(row=>row[key]===value);return range;},lt:(key,value)=>{selected=selected.filter(row=>row[key]<value);return range;}};fn?.(range);return chain;},
        order:direction=>{selected.sort((a,b)=>direction==='desc'?b.createdAt-a.createdAt:a.createdAt-b.createdAt);return chain;},
        collect:async()=>selected,take:async n=>selected.slice(0,n),unique:async()=>selected[0]??null,
      };return chain;
    },
  };
  return {db,jobs,rows,scheduler:{runAfter:async(...args)=>jobs.push(args)}};
}
function booking(extra={}) {return {_id:'booking',status:'approved',revision:1,room:'Shema Space',roomKey:'shema space',timezone:'Asia/Singapore',requesterName:'Person',requesterEmail:'person@example.com',eventName:'Base',jotformSubmissionId:'s',jotformFormId:'f',startAt:occurrences[0].startAt,endAt:occurrences[0].endAt,occurrences:structuredClone(occurrences),recurrenceFrequency:'weekly_same_day',recurrenceCount:3,recurrenceHasEndDate:false,resolvedVenues:['Shema Space'],...extra};}
async function calendarEnabled(run) {const old=process.env.GOOGLE_CALENDAR_ENABLED;process.env.GOOGLE_CALENDAR_ENABLED='true';try{await run();}finally{if(old===undefined)delete process.env.GOOGLE_CALENDAR_ENABLED;else process.env.GOOGLE_CALENDAR_ENABLED=old;}}
test('three scopes select exactly one, the chronological tail, or all dates',()=>{
  assert.deepEqual([...scopedSequences(occurrences,'occurrence',1)],[1]);
  assert.deepEqual([...scopedSequences(occurrences,'following',1)],[1,2]);
  assert.deepEqual([...scopedSequences(occurrences,'series')],[0,1,2]);
  assert.throws(()=>scopedSequences(occurrences,'following',99));
});
test('following uses chronological starts rather than sequence numbers',()=>{
  const reordered=[{...occurrences[2],sequence:0},{...occurrences[0],sequence:9},{...occurrences[1],sequence:5}];
  assert.deepEqual([...scopedSequences(reordered,'following',5)],[0,5]);
});
test('following edit preserves earlier meeting and shifts later times and scoped metadata',()=>{
  const next=editScopedOccurrences(occurrences,'following',1,{startAt:occurrences[1].startAt+60000,endAt:occurrences[1].endAt+120000,room:'Board Room',resolvedVenues:['Board Room'],details:{eventName:'Changed',purpose:''}});
  assert.deepEqual(next[0],occurrences[0]);
  for(const item of next.slice(1)){assert.equal(item.startAt,occurrences[item.sequence].startAt+60000);assert.equal(item.endAt-item.startAt,3660000);assert.equal(item.details.eventName,'Changed');assert.equal(item.room,'Board Room');}
});
test('single meeting edit does not change its later peer',()=>{
  const next=editScopedOccurrences(occurrences,'occurrence',1,{startAt:occurrences[1].startAt,endAt:occurrences[1].endAt,room:'Board Room',resolvedVenues:['Board Room'],details:{eventName:'Only this'}});
  assert.deepEqual(next[2],occurrences[2]);assert.deepEqual(next[0],occurrences[0]);
});
for(const scope of ['occurrence','following'])test(`${scope} cancellation retains peers, rebuilds claims, and queues Calendar`,async()=>calendarEnabled(async()=>{
  const b=booking();const ctx=context({bookings:[b]});
  const result=await bookings.removeOccurrences.handler(ctx,{bookingId:'booking',expectedRevision:1,scope,occurrenceSequence:1});
  const saved=await ctx.db.get('booking');assert.equal(result.calendarQueued,true);
  assert.deepEqual(saved.occurrences.map(x=>x.sequence),scope==='occurrence'?[0,2]:[0]);
  assert.equal(saved.calendarSyncStatus,'creating');assert.equal(saved.revision,2);
  assert.equal(ctx.rows('bookingClaims').length,saved.occurrences.length);
  assert.ok(ctx.jobs.some(job=>job[0]===0&&job[1]==='reconcileApprovedBooking'));
}));
test('removing the first meeting updates the booking summary date',async()=>calendarEnabled(async()=>{
  const ctx=context({bookings:[booking()]});await bookings.removeOccurrences.handler(ctx,{bookingId:'booking',expectedRevision:1,scope:'occurrence',occurrenceSequence:0});
  assert.equal((await ctx.db.get('booking')).startAt,occurrences[1].startAt);
}));
test('selecting every remaining meeting delegates to safe whole-booking deletion',async()=>{
  const ctx=context({bookings:[booking()]});
  assert.deepEqual(await bookings.removeOccurrences.handler(ctx,{bookingId:'booking',expectedRevision:1,scope:'following',occurrenceSequence:0}),{deleteAllRequired:true,calendarQueued:false});
  assert.equal((await ctx.db.get('booking')).revision,1);assert.equal(ctx.jobs.length,0);
});
test('stale revisions and active Calendar leases block partial removal',async()=>{
  for(const extra of [{revision:2},{calendarSyncToken:'busy'}]){
    const ctx=context({bookings:[booking(extra)]});await assert.rejects(bookings.removeOccurrences.handler(ctx,{bookingId:'booking',expectedRevision:1,scope:'occurrence',occurrenceSequence:1}));assert.equal(ctx.jobs.length,0);
  }
});
test('partial editing stores event details only on selected occurrences',async()=>calendarEnabled(async()=>{
  const b=booking();const ctx=context({bookings:[b]});
  await bookings.edit.handler(ctx,{...b,bookingId:b._id,expectedRevision:1,editScope:'following',occurrenceSequence:1,startAt:occurrences[1].startAt+60000,endAt:occurrences[1].endAt+60000,eventName:'Tail',room:'Board Room'});
  const saved=await ctx.db.get('booking');assert.equal(saved.eventName,'Base');assert.equal(saved.occurrences[0].details,undefined);assert.equal(saved.occurrences[1].details.eventName,'Tail');assert.equal(saved.occurrences[2].details.eventName,'Tail');
}));
test('all-events edit changes metadata for every meeting, including previous overrides',async()=>calendarEnabled(async()=>{
  const b=booking();b.occurrences[1].details={eventName:'Exception'};const ctx=context({bookings:[b]});
  await bookings.edit.handler(ctx,{...b,bookingId:b._id,expectedRevision:1,editScope:'series',eventName:'All meetings'});
  const saved=await ctx.db.get('booking');assert.equal(saved.eventName,'All meetings');assert.ok(saved.occurrences.every(item=>!item.details));assert.equal(saved.calendarSyncStatus,'creating');
}));
test('series time change does not recreate a previously removed date',async()=>calendarEnabled(async()=>{
  const b=booking({occurrences:[occurrences[0],occurrences[2]],recurrenceCount:2});const ctx=context({bookings:[b]});
  await bookings.edit.handler(ctx,{...b,bookingId:b._id,expectedRevision:1,editScope:'series',startAt:b.startAt+60000,endAt:b.endAt+60000});
  const saved=await ctx.db.get('booking');assert.equal(saved.occurrences.length,2);assert.equal(saved.occurrences[1].startAt,occurrences[2].startAt+60000);
}));
test('support classification covers severities and suspicious/failure markers without recursion',()=>{
  for(const log of [{level:'warning',action:'booking_deleted',message:'Removed'},{level:'error',action:'calendar',message:'API problem'},{level:'info',action:'request',message:'Suspicious login'},{level:'info',action:'sync_failed',message:'Retry'}])assert.equal(needsSupportAlert(log),true);
  assert.equal(needsSupportAlert({level:'info',action:'booking_created',message:'Saved'}),false);
  assert.equal(needsSupportAlert({level:'error',action:'tech_alert_delivery_failed',message:'Failed'}),false);
});
test('an audit warning creates one immediate developer delivery and ignores legacy recipients',async()=>{
  const ctx=context({techSupportEmails:[{_id:'r1',email:'a@example.com',active:true},{_id:'r2',email:'b@example.com',active:false},{_id:'r3',email:'c@example.com',active:true}]});
  await writeAuditLog(ctx,{level:'warning',category:'booking',action:'check_failed',actorType:'system',message:'Failed',createdAt:now});
  assert.equal(ctx.rows('auditLogs').length,1);assert.equal(ctx.rows('techAlertDeliveries').length,1);assert.deepEqual(ctx.rows('techAlertDeliveries').map(row=>row.email),['a@example.com']);assert.ok(ctx.jobs.every(job=>job[0]===0&&job[1]==='sendTechAlert'));
});
test('app cannot change the environment-owned developer recipient',async()=>{
  const ctx=context();await assert.rejects(support.save.handler(ctx,{email:'other@example.com',active:true}));assert.equal(ctx.rows('techSupportEmails').length,0);
});
function deliveryContext(extra={}) {return context({techSupportEmails:[{_id:'recipient',email:'a@example.com',active:true}],auditLogs:[{_id:'log',message:'Failed'}],techAlertDeliveries:[{_id:'delivery',logId:'log',recipientId:'recipient',email:'a@example.com',status:'pending',attempts:0,...extra}]});}
test('delivery lease suppresses concurrent sends and success prevents replay',async()=>{
  const ctx=deliveryContext();assert.ok(await support.claim.handler(ctx,{deliveryId:'delivery',token:'a'}));assert.equal(await support.claim.handler(ctx,{deliveryId:'delivery',token:'b'}),null);
  await support.finish.handler(ctx,{deliveryId:'delivery',token:'a'});assert.equal((await ctx.db.get('delivery')).status,'sent');assert.equal(await support.claim.handler(ctx,{deliveryId:'delivery',token:'c'}),null);
});
test('developer address rotation cancels an unsent alert at worker start',async()=>{
  const ctx=deliveryContext();process.env.DEVELOPER_EMAIL='new@example.com';try{assert.equal(await support.claim.handler(ctx,{deliveryId:'delivery',token:'a'}),null);assert.equal((await ctx.db.get('delivery')).status,'cancelled');}finally{process.env.DEVELOPER_EMAIL='a@example.com';}
});
test('failed alert retries with backoff and exhausts without recursive emails',async()=>{
  const ctx=deliveryContext();await support.claim.handler(ctx,{deliveryId:'delivery',token:'a'});await support.finish.handler(ctx,{deliveryId:'delivery',token:'a',error:'Gmail down'});
  assert.equal((await ctx.db.get('delivery')).status,'pending');assert.ok(ctx.jobs.some(job=>job[0]===60000&&job[1]==='sendTechAlert'));
  await ctx.db.patch('delivery',{status:'sending',attempts:5,leaseToken:'last'});await support.finish.handler(ctx,{deliveryId:'delivery',token:'last',error:'Still down'});assert.equal((await ctx.db.get('delivery')).status,'failed');assert.equal(ctx.rows('techAlertDeliveries').length,1);assert.equal(ctx.rows('auditLogs').at(-1).action,'tech_alert_delivery_failed');
});
test('expired worker lease recovers and old worker cannot acknowledge new attempt',async()=>{
  const ctx=deliveryContext({status:'sending',attempts:1,leaseToken:'expired',leaseExpiresAt:now-1000});await support.recover.handler(ctx,{deliveryId:'delivery',token:'expired'});assert.equal((await ctx.db.get('delivery')).status,'pending');await support.claim.handler(ctx,{deliveryId:'delivery',token:'new'});await support.finish.handler(ctx,{deliveryId:'delivery',token:'expired'});assert.equal((await ctx.db.get('delivery')).status,'sending');
});
test('support sender sends a redacted log summary through Gmail and records success',async()=>{
  const emails=await import('../convex/emailNotifications.ts');
  const settings={APP_BASE_URL:'https://roomops.example.test',GMAIL_CLIENT_ID:'fake-client',GMAIL_CLIENT_SECRET:'fake-secret',GMAIL_REFRESH_TOKEN:'fake-refresh',GMAIL_FROM_EMAIL:'sender@example.com'};
  const previous=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));
  const oldFetch=globalThis.fetch;let mime='';let finished;
  Object.assign(process.env,settings);
  globalThis.fetch=async(url,init)=>{
    if(String(url).includes('oauth2'))return new Response(JSON.stringify({access_token:'fake',expires_in:3600}));
    assert.match(String(url),/gmail.googleapis.com/);mime=Buffer.from(JSON.parse(init.body).raw,'base64url').toString();return new Response(JSON.stringify({id:'accepted'}));
  };
  try {
    await emails.sendTechAlert.handler({runMutation:async(name,args)=>{
      if(name==='claim')return {email:'support@example.com',log:{_id:'log-123',level:'error',category:'booking',action:'sync_failed',createdAt:now,message:'Failure token=TOPSECRET https://private.example/?secret=HIDDEN',detailsJson:'RAW_PRIVATE_DETAILS'}};
      if(name==='finish')finished=args;
    }},{deliveryId:'delivery'});
    assert.match(mime,/To: support@example.com/);assert.match(mime,/log-123/);assert.match(mime,/https:\/\/roomops.example.test\/logs/);
    assert.doesNotMatch(mime,/TOPSECRET|HIDDEN|RAW_PRIVATE_DETAILS/);assert.equal(finished.error,undefined);
  }finally{globalThis.fetch=oldFetch;for(const[k,val]of Object.entries(previous)){if(val===undefined)delete process.env[k];else process.env[k]=val;}}
});
test('missing Gmail configuration is captured for delivery retry without recursive logging',async()=>{
  const emails=await import('../convex/emailNotifications.ts');const old=process.env.APP_BASE_URL;delete process.env.APP_BASE_URL;const calls=[];
  try {
    await emails.sendTechAlert.handler({runMutation:async(name,args)=>{calls.push({name,args});if(name==='claim')return {email:'support@example.com',log:{}};}},{deliveryId:'delivery'});
    assert.deepEqual(calls.map(c=>c.name),['claim','finish']);assert.match(calls[1].args.error,/APP_BASE_URL/);
  }finally{if(old!==undefined)process.env.APP_BASE_URL=old;}
});
