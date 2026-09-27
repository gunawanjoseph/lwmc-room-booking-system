import './roomops-regression-hooks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const reminders=await import('../convex/bookingReminders.ts');
const bookings=await import('../convex/bookings.ts');
const requests=await import('../convex/bookingRequests.ts');
const emails=await import('../convex/emailNotifications.ts');
const HOUR=3600000, NOW=Date.UTC(2026,8,20,0);
function booking(extra={}) {return {_id:'booking',jotformSubmissionId:'123',jotformFormId:'form',status:'approved',revision:1,createdAt:NOW,calendarSyncedAt:NOW,
  requesterEmail:'owner@example.com',requesterName:'Owner',room:'Shema Space',roomKey:'shema space',resolvedVenues:['Shema Space'],eventName:'Meeting',timezone:'Asia/Singapore',
  startAt:NOW+72*HOUR,endAt:NOW+73*HOUR,calendarSyncStatus:'synced',...extra};}
async function clock(run) {const old=Date.now;let now=NOW;Date.now=()=>now;try {await run(value=>now=value);}finally{Date.now=old;}}
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
for(const [hours,kinds] of [[72,['two_days','two_hours']],[24,['two_hours']],[1,[]]])test(`booking added ${hours} hours before start schedules only eligible reminders`,async()=>clock(async()=>{
 const b=booking({startAt:NOW+hours*HOUR,endAt:NOW+(hours+1)*HOUR}),ctx=context({bookings:[b]});
 await reminders.planReminders(ctx,b,NOW);assert.deepEqual(ctx.rows('bookingReminders').map(x=>x.kind),kinds);
 await reminders.planReminders(ctx,b,NOW);assert.equal(ctx.rows('bookingReminders').length,kinds.length);
 for(const job of ctx.rows('bookingReminders'))assert.equal(job.dueAt,job.startAt-reminders.reminderOffsets[job.kind]);
}));
test('each recurring occurrence gets its own reminders, with latest details at delivery',async()=>clock(async setTime=>{
 const b=booking({occurrences:[{sequence:0,startAt:NOW+72*HOUR,endAt:NOW+73*HOUR},{sequence:1,startAt:NOW+240*HOUR,endAt:NOW+241*HOUR}]}),ctx=context({bookings:[b]});
 await reminders.planReminders(ctx,b,NOW);assert.equal(ctx.rows('bookingReminders').length,4);
 await ctx.db.patch('booking',{eventName:'Updated title',requesterEmail:'new@example.com'});
 const row=ctx.rows('bookingReminders')[0];setTime(row.dueAt);
 const claimed=await reminders.claim.handler(ctx,{reminderId:row._id,token:'first'});
 assert.equal(claimed.meeting.title,'Updated title');assert.equal(claimed.booking.requesterEmail,'new@example.com');assert.match(claimed.linkToken,/^[a-f0-9]{64}$/);
 assert.equal(await reminders.claim.handler(ctx,{reminderId:row._id,token:'duplicate'}),null);
 await reminders.finish.handler(ctx,{reminderId:row._id,token:'wrong'});assert.equal(row.status,'sending');
 await reminders.finish.handler(ctx,{reminderId:row._id,token:'first'});assert.equal(row.status,'sent');assert.equal((await ctx.db.get('booking')).reminderLeaseToken,undefined);
 assert.equal(await reminders.claim.handler(ctx,{reminderId:row._id,token:'duplicate'}),null);
}));
test('rescheduling invalidates the old time and does not backfill passed reminders',async()=>clock(async setTime=>{
 const b=booking(),ctx=context({bookings:[b]});await reminders.planReminders(ctx,b,NOW);
 const old=ctx.rows('bookingReminders')[0];const changed={...b,startAt:NOW+24*HOUR,endAt:NOW+25*HOUR};await ctx.db.patch('booking',changed);
 await reminders.planReminders(ctx,changed,NOW);assert.equal(old.status,'skipped');assert.equal(ctx.rows('bookingReminders').filter(x=>x.status==='pending').length,1);
 setTime(old.dueAt);assert.equal(await reminders.claim.handler(ctx,{reminderId:old._id,token:'old'}),null);
}));
test('cancelled bookings and removed recurring occurrences never send reminders',async()=>clock(async setTime=>{
 for(const extra of [{status:'cancelled'},{occurrences:[]}]){const b=booking(),ctx=context({bookings:[b]});await reminders.planReminders(ctx,b,NOW);const row=ctx.rows('bookingReminders')[0];await ctx.db.patch('booking',extra);setTime(row.dueAt);assert.equal(await reminders.claim.handler(ctx,{reminderId:row._id,token:'worker'}),null);assert.equal(row.status,'skipped');setTime(NOW);}
}));
test('pending Calendar operations defer reminders, but late reminders are skipped',async()=>clock(async setTime=>{
 const b=booking(),ctx=context({bookings:[b]});await reminders.planReminders(ctx,b,NOW);const row=ctx.rows('bookingReminders')[0];setTime(row.dueAt);
 await ctx.db.patch('booking',{calendarSyncStatus:'creating'});assert.equal(await reminders.claim.handler(ctx,{reminderId:row._id,token:'worker'}),null);assert.equal(row.status,'pending');assert.equal(ctx.jobs.at(-1)[0],60000);
 setTime(row.dueAt+16*60000);assert.equal(await reminders.claim.handler(ctx,{reminderId:row._id,token:'worker'}),null);assert.equal(row.status,'skipped');
}));
test('failed delivery retries within its window and releases the edit lock',async()=>clock(async setTime=>{
 const b=booking(),ctx=context({bookings:[b]});await reminders.planReminders(ctx,b,NOW);const row=ctx.rows('bookingReminders')[0];setTime(row.dueAt);await reminders.claim.handler(ctx,{reminderId:row._id,token:'worker'});
 await assert.rejects(bookings.beginBookingDeletion.handler(ctx,{bookingId:'booking',expectedRevision:1,actorId:'admin',deletionToken:'cancel'}),/reminder/);
 await reminders.finish.handler(ctx,{reminderId:row._id,token:'worker',error:'Gmail unavailable'});assert.equal(row.status,'pending');assert.equal((await ctx.db.get('booking')).reminderLeaseToken,undefined);assert.equal(ctx.jobs.at(-1)[0],60000);assert.ok(ctx.rows('auditLogs').some(x=>x.action==='booking_reminder_failed'));
}));
test('expired send lease is marked uncertain without sending a duplicate',async()=>clock(async setTime=>{
 const b=booking(),ctx=context({bookings:[b]});await reminders.planReminders(ctx,b,NOW);const row=ctx.rows('bookingReminders')[0];setTime(row.dueAt);await reminders.claim.handler(ctx,{reminderId:row._id,token:'worker'});setTime(row.dueAt+32*60000);
 assert.equal(await reminders.claim.handler(ctx,{reminderId:row._id,token:'second'}),null);await reminders.recover.handler(ctx,{reminderId:row._id,token:'worker'});assert.equal(row.status,'failed');assert.equal((await ctx.db.get('booking')).reminderLeaseToken,undefined);
}));
test('cancelled records are read-only, retain receipts, and only then allow erasure',async()=>clock(async()=>{
 const b=booking(),ctx=context({bookings:[b],requesterLinks:[{_id:'link',bookingId:'booking',email:b.requesterEmail,token:'a'.repeat(64)}]});
 await assert.rejects(bookings.eraseCancelled.handler(ctx,{bookingId:'booking',expectedRevision:1}),/Cancel the booking/);
 await bookings.deleteBookingRecord(ctx,b,'admin');const cancelled=await ctx.db.get('booking');assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.eventName,'Meeting');assert.deepEqual(cancelled.calendarEvents,[]);
 assert.equal((await requests.view.handler(ctx,{token:'a'.repeat(64)})).cancelled,true);
 await assert.rejects(bookings.beginBookingDeletion.handler(ctx,{bookingId:'booking',expectedRevision:cancelled.revision,actorId:'admin',deletionToken:'cancel'}),/is cancelled/);
 await assert.rejects(bookings.saveTableEdits.handler(ctx,{clientRequestId:'edit',edits:[{bookingId:'booking',expectedRevision:cancelled.revision,requesterName:'Edited',requesterEmail:b.requesterEmail,eventName:'Changed',responseEdits:[]}]}),/is cancelled/);
 await bookings.eraseCancelled.handler(ctx,{bookingId:'booking',expectedRevision:cancelled.revision});assert.equal(await ctx.db.get('booking'),null);assert.ok(ctx.rows('requesterLinks')[0].revokedAt);
 assert.equal(await requests.view.handler(ctx,{token:'a'.repeat(64)}),null);
}));
test('partial cancellations retain unique read-only records and cannot erase before cleanup',async()=>clock(async()=>{
 const b=booking(),ctx=context({bookings:[b]});const occurrence={sequence:3,startAt:NOW+96*HOUR,endAt:NOW+97*HOUR,room:'Board Room',details:{eventName:'Exception'}};
 await bookings.archiveCancelledOccurrences(ctx,b,[occurrence],'admin','No longer needed',true);const archive=ctx.rows('bookings').find(x=>x._id!=='booking');
 assert.equal(archive.status,'cancelled');assert.equal(archive.sourceSubmissionId,'123');assert.notEqual(archive.jotformSubmissionId,b.jotformSubmissionId);assert.equal(archive.eventName,'Exception');assert.equal(archive.room,'Board Room');assert.equal(archive.occurrences[0].sequence,3);assert.equal(archive.occurrences[0].details.eventName,"Exception");
 await assert.rejects(bookings.eraseCancelled.handler(ctx,{bookingId:archive._id,expectedRevision:0}),/cleanup/);
 await bookings.finalizeCancelledParts(ctx,'booking');await bookings.eraseCancelled.handler(ctx,{bookingId:archive._id,expectedRevision:0});assert.equal((await ctx.db.get('booking')).status,'approved');
}));
async function gmail(run){
 const settings={APP_BASE_URL:'https://roomops.example.test',GMAIL_CLIENT_ID:'fake',GMAIL_CLIENT_SECRET:'fake',GMAIL_REFRESH_TOKEN:'fake',GMAIL_FROM_EMAIL:'sender@example.com'};
 const previous=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));const oldFetch=globalThis.fetch;const sent=[];Object.assign(process.env,settings);
 globalThis.fetch=async(url,init)=>{if(String(url).includes('oauth2'))return new Response(JSON.stringify({access_token:'fake',expires_in:3600}));sent.push(Buffer.from(JSON.parse(init.body).raw,'base64url').toString());return new Response(JSON.stringify({id:'sent'}));};
 try{await run(sent);}finally{globalThis.fetch=oldFetch;for(const[k,val]of Object.entries(previous)){if(val===undefined)delete process.env[k];else process.env[k]=val;}}
}
for(const kind of ['two_days','two_hours'])test(`${kind} email sends correct private actions and responsive details`,async()=>clock(async setTime=>gmail(async sent=>{
 const b=booking(),ctx=context({bookings:[b]});await reminders.planReminders(ctx,b,NOW);const row=ctx.rows('bookingReminders').find(x=>x.kind===kind);setTime(row.dueAt);
 ctx.runMutation=(name,args)=>reminders[name].handler(ctx,args);
 ctx.runQuery=async()=>({page:[],isDone:true,continueCursor:'',timezone:'Asia/Singapore'});
 await emails.sendBookingReminder.handler(ctx,{reminderId:row._id});assert.equal(sent.length,1);assert.equal(row.status,'sent');assert.match(sent[0],/Meeting/);assert.match(sent[0],/Shema Space/);assert.match(sent[0],/max-width:620px/);assert.match(sent[0],/Your outstanding bookings/);
 if(kind==='two_days'){assert.match(sent[0],/booking-request#token=[a-f0-9]{64}&meeting=0/);assert.match(sent[0],/action=cancel/);assert.doesNotMatch(sent[0],/bookingId=|userId=/);}else{assert.match(sent[0],/Online changes and cancellations are now closed/);assert.doesNotMatch(sent[0],/booking-request#token/);}
})));
test('restoring a future meeting time re-enrolls its unsent invalidated reminder',async()=>clock(async()=>{
 const b=booking(),ctx=context({bookings:[b]});await reminders.planReminders(ctx,b,NOW);
 await reminders.planReminders(ctx,{...b,startAt:NOW+100*HOUR,endAt:NOW+101*HOUR},NOW);
 assert.equal(ctx.rows('bookingReminders')[0].status,'skipped');await reminders.planReminders(ctx,b,NOW);
 assert.equal(ctx.rows('bookingReminders')[0].status,'pending');assert.equal(ctx.rows('bookingReminders').filter(x=>x.status==='pending').length,2);
}));
test('archiving an exception does not replace inherited details of other cancelled meetings',async()=>clock(async()=>{
 const b=booking(),ctx=context({bookings:[b]});
 await bookings.archiveCancelledOccurrences(ctx,b,[{sequence:0,startAt:NOW+72*HOUR,endAt:NOW+73*HOUR,details:{eventName:'Exception'}},{sequence:1,startAt:NOW+96*HOUR,endAt:NOW+97*HOUR}],'admin');
 const archive=ctx.rows('bookings')[1];const {requestMeetings}=await import('../convex/lib/requesterRules.ts');
 assert.deepEqual(requestMeetings(archive).map(x=>x.title),['Exception','Meeting']);
}));
