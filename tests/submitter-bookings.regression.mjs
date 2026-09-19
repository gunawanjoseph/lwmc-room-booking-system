import './roomops-regression-hooks.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const rules=await import('../convex/lib/submitterBookings.ts');
const own=await import('../convex/myBookings.ts');
const bookings=await import('../convex/bookings.ts');
const notices=await import('../convex/bookingNotices.ts');
const emails=await import('../convex/emailNotifications.ts');
const {queueBookingNotice}=await import('../convex/lib/bookingNotice.ts');
const now=Date.parse('2026-09-17T16:00:00Z'); // September 18 in Singapore.
function booking(extra={}){return {_id:'booking',jotformSubmissionId:'123',jotformFormId:'form',requesterName:'Person',requesterEmail:'person@example.com',room:'Shema Space',roomKey:'shema space',timezone:'Asia/Singapore',eventName:'Meeting',status:'pending',revision:1,createdAt:now-86400000,startAt:now+3600000,endAt:now+7200000,occurrences:[0,1,2].map(sequence=>({sequence,startAt:now+3600000+sequence*86400000,endAt:now+7200000+sequence*86400000})),resolvedVenues:['Shema Space'],recurrenceFrequency:'weekly_same_day',recurrenceCount:3,recurrenceHasEndDate:false,...extra};}
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
test('outstanding starts at local midnight without a future cutoff',()=>{
  assert.deepEqual(rules.bookingWindow(now),{today:'2026-09-18',timezone:'Asia/Singapore'});
  const starts=['2026-09-17T15:59:59Z','2026-09-17T16:00:00Z','2027-09-18T15:59:59Z','2027-09-18T16:00:00Z'].map(Date.parse);
  const rows=starts.flatMap((startAt,i)=>rules.submitterMeetings(booking({_id:String(i),startAt,endAt:startAt+1000,occurrences:undefined})));
  assert.deepEqual(rules.filterMeetings(rows,'outstanding',now,'Asia/Singapore').map(x=>x.key),['1:0','2:0','3:0']);
});
test('leap day has no artificial upper boundary',()=>{
  assert.deepEqual(rules.bookingWindow(Date.parse('2024-02-29T04:00:00Z')),{today:'2024-02-29',timezone:'Asia/Singapore'});
});
test('recurring rows respect per-meeting room/title overrides and retain earlier dates in past view',()=>{
  const b=booking();b.occurrences[0].startAt=now-86400000;b.occurrences[1].room='Board Room';b.occurrences[1].details={eventName:'Exception'};
  const rows=rules.submitterMeetings(b);assert.equal(rows[1].room,'Board Room');assert.equal(rows[1].title,'Exception');assert.equal(rules.filterMeetings(rows,'past',now,'Asia/Singapore').length,1);assert.equal(rules.filterMeetings(rows,'outstanding',now,'Asia/Singapore').length,2);
});
test('outstanding excludes rejected/unavailable; pending and all preserve their expected sets',()=>{
  const rows=['pending','approved','rejected','unavailable'].flatMap(status=>rules.submitterMeetings(booking({_id:status,status,occurrences:undefined})));
  assert.deepEqual(rules.filterMeetings(rows,'outstanding',now,'Asia/Singapore').map(x=>x.status),['pending','approved']);
  assert.equal(rules.filterMeetings(rows,'pending',now,'Asia/Singapore').length,1);assert.equal(rules.filterMeetings(rows,'all',now,'Asia/Singapore').length,4);
});
test('sort by booking or submission date uses the selected field and a stable tie-breaker',()=>{
  const first=rules.submitterMeetings(booking({_id:'first',submittedAt:20,createdAt:99,occurrences:undefined}))[0];
  const second={...first,key:'second',submittedAt:10,startAt:first.startAt+1000};
  assert.equal(first.submittedAt,20);assert.equal(first.submissionDateEstimated,false);
  assert.deepEqual(rules.sortMeetings([second,first],'booking','asc').map(x=>x.key),['first:0','second']);assert.deepEqual(rules.sortMeetings([first,second],'submitted','asc').map(x=>x.key),['second','first:0']);assert.deepEqual(rules.sortMeetings([first,second],'submitted','desc').map(x=>x.key),['first:0','second']);
  assert.equal(rules.submitterMeetings(booking())[0].submissionDateEstimated,true);
});
test('submitter lookup requires verified ownership, never administrator status',async()=>{
  const ctx=context({bookings:[booking(),booking({_id:'other',requesterEmail:'other@example.com'})]});
  ctx.auth={getUserIdentity:async()=>({subject:'submitter-not-admin',email:'PERSON@example.com',emailVerified:true})};
  const result=await own.list.handler(ctx,{email:' person@example.com ',paginationOpts:{numItems:20,cursor:null}});assert.equal(result.page.length,1);assert.equal(result.page[0].id,'booking');assert.equal(result.page[0].meetings[0].requesterEmail,undefined);
  await assert.rejects(own.list.handler(ctx,{email:'other@example.com',paginationOpts:{numItems:20,cursor:null}}));
  for(const identity of [null,{email:'person@example.com',emailVerified:false},{email:'person@example.com',emailVerified:'true'}]){ctx.auth.getUserIdentity=async()=>identity;await assert.rejects(own.list.handler(ctx,{email:'person@example.com',paginationOpts:{numItems:20,cursor:null}}));}
});
test('email-only internal query projects just recipient booking details',async()=>{
  const ctx=context({bookings:[booking({reviewedBy:'private-admin',formResponses:[{value:'private'}]}),booking({_id:'other',requesterEmail:'other@example.com'})]});
  const result=await own.emailPage.handler(ctx,{email:'PERSON@example.com',paginationOpts:{numItems:20,cursor:null}});assert.equal(result.page.length,3);assert.equal(result.page[0].formResponses,undefined);assert.equal(result.page[0].reviewedBy,undefined);
});
test('partial cancellation queues a snapshot only when opted in and never for a failed revision',async()=>{
  for(const notifySubmitter of [false,true]){const ctx=context({bookings:[booking()]});await bookings.removeOccurrences.handler(ctx,{bookingId:'booking',expectedRevision:1,scope:'occurrence',occurrenceSequence:1,notifySubmitter});assert.equal(ctx.rows('bookingNotices').length,notifySubmitter?1:0);if(notifySubmitter){const row=ctx.rows('bookingNotices')[0];assert.equal(JSON.parse(row.beforeJson).length,1);assert.equal(JSON.parse(row.afterJson).length,0);assert.equal(row.kind,'deleted');}}
  const ctx=context({bookings:[booking()]});await assert.rejects(bookings.removeOccurrences.handler(ctx,{bookingId:'booking',expectedRevision:999,scope:'occurrence',occurrenceSequence:1,notifySubmitter:true}));assert.equal(ctx.rows('bookingNotices').length,0);
});
test('full-series fallback queues no premature cancellation message',async()=>{
  const ctx=context({bookings:[booking()]});const result=await bookings.removeOccurrences.handler(ctx,{bookingId:'booking',expectedRevision:1,scope:'following',occurrenceSequence:0,notifySubmitter:true});assert.equal(result.deleteAllRequired,true);assert.equal(ctx.rows('bookingNotices').length,0);
});
test('full deletion queues email at commit and preserves its snapshot after the booking is gone',async()=>{
  const ctx=context({bookings:[booking({deletionToken:'lease',deletionLeaseExpiresAt:Date.now()+60000})]});
  await bookings.completeBookingDeletion.handler(ctx,{bookingId:'booking',actorId:'admin',deletionToken:'lease',notifySubmitter:true});assert.equal(await ctx.db.get('booking'),null);assert.equal(ctx.rows('bookingNotices').length,1);assert.equal(JSON.parse(ctx.rows('bookingNotices')[0].beforeJson).length,3);
  await bookings.completeBookingDeletion.handler(ctx,{bookingId:'booking',actorId:'admin',deletionToken:'lease',notifySubmitter:true});assert.equal(ctx.rows('bookingNotices').length,1);
});
test('lost deletion lease never queues a submitter notification',async()=>{
  const ctx=context({bookings:[booking({deletionToken:'new',deletionLeaseExpiresAt:Date.now()+60000})]});await assert.rejects(bookings.completeBookingDeletion.handler(ctx,{bookingId:'booking',actorId:'admin',deletionToken:'old',notifySubmitter:true}));assert.equal(ctx.rows('bookingNotices').length,0);assert.ok(await ctx.db.get('booking'));
});
test('edited notification uses updated recipient and records metadata/scope changes',async()=>{
  const ctx=context();const before=booking(),after={...before,requesterEmail:'corrected@example.com',purpose:'New purpose',calendarSyncStatus:'creating'};
  await queueBookingNotice(ctx,before,after,'edited','following',1);const notice=ctx.rows('bookingNotices')[0];assert.equal(notice.recipientEmail,'corrected@example.com');assert.equal(notice.calendarPending,true);assert.match(notice.detailChanges,/New purpose/);assert.equal(JSON.parse(notice.beforeJson).length,2);
});
test('notice leases prevent duplicate sends; failed delivery retries and can be manually retried',async()=>{
  const ctx=context();await queueBookingNotice(ctx,booking(),null,'deleted');const noticeId=ctx.rows('bookingNotices')[0]._id;
  assert.ok(await notices.claim.handler(ctx,{noticeId,token:'one'}));assert.equal(await notices.claim.handler(ctx,{noticeId,token:'two'}),null);await notices.finish.handler(ctx,{noticeId,token:'two'});assert.equal((await ctx.db.get(noticeId)).status,'sending');
  await notices.finish.handler(ctx,{noticeId,token:'one',error:'Gmail down'});assert.equal((await ctx.db.get(noticeId)).status,'pending');
  for(let i=2;i<=5;i++){await notices.claim.handler(ctx,{noticeId,token:String(i)});await notices.finish.handler(ctx,{noticeId,token:String(i),error:'Gmail down'});}
  assert.equal((await ctx.db.get(noticeId)).status,'failed');const result=await emails.retryFailedInternal.handler(ctx,{});assert.equal(result.queued,1);assert.equal((await ctx.db.get(noticeId)).attempts,0);
});
test('expired notice lease is recovered and stale worker completion is ignored',async()=>{
  const ctx=context();await queueBookingNotice(ctx,booking(),null,'deleted');const noticeId=ctx.rows('bookingNotices')[0]._id;await notices.claim.handler(ctx,{noticeId,token:'expired'});await ctx.db.patch(noticeId,{leaseExpiresAt:0});await notices.recover.handler(ctx,{noticeId,token:'expired'});await notices.claim.handler(ctx,{noticeId,token:'new'});await notices.finish.handler(ctx,{noticeId,token:'expired'});assert.equal((await ctx.db.get(noticeId)).status,'sending');
});
test('meeting table escapes HTML content',()=>{
  const row=rules.submitterMeetings(booking({eventName:'<script>unsafe</script>'}))[0];assert.match(rules.meetingTable([row]).html,/&lt;script&gt;/);assert.doesNotMatch(rules.meetingTable([row]).html,/<script>/);
});
test('booking edit queues the opted-in email transactionally; default remains silent',async()=>{
  for(const notifySubmitter of [false,true]){
    const b=booking();const ctx=context({bookings:[b]});await bookings.edit.handler(ctx,{...b,bookingId:b._id,expectedRevision:1,editScope:'series',eventName:'Updated title',notifySubmitter});
    assert.equal((await ctx.db.get('booking')).eventName,'Updated title');assert.equal(ctx.rows('bookingNotices').length,notifySubmitter?1:0);
    if(notifySubmitter)assert.equal(JSON.parse(ctx.rows('bookingNotices')[0].beforeJson)[0].title,'Meeting');
  }
});
test('table edits can opt in; unchanged rows do not generate messages',async()=>{
  const b=booking();const ctx=context({bookings:[b]});const edit={bookingId:b._id,expectedRevision:1,requesterName:b.requesterName,requesterEmail:b.requesterEmail,eventName:b.eventName,responseEdits:[]};
  await bookings.saveTableEdits.handler(ctx,{clientRequestId:'no-change',edits:[edit],notifySubmitter:true});assert.equal(ctx.rows('bookingNotices').length,0);
  await bookings.saveTableEdits.handler(ctx,{clientRequestId:'changed',edits:[{...edit,eventName:'Edited from table'}],notifySubmitter:true});assert.equal(ctx.rows('bookingNotices').length,1);assert.match(ctx.rows('bookingNotices')[0].detailChanges,/Edited from table/);
});
async function gmail(run){
  const settings={APP_BASE_URL:'https://roomops.example.test',GMAIL_CLIENT_ID:'fake',GMAIL_CLIENT_SECRET:'fake',GMAIL_REFRESH_TOKEN:'fake',GMAIL_FROM_EMAIL:'sender@example.com'};
  const previous=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));const oldFetch=globalThis.fetch;const sent=[];
  Object.assign(process.env,settings);globalThis.fetch=async(url,init)=>{if(String(url).includes('oauth2'))return new Response(JSON.stringify({access_token:'fake',expires_in:3600}));sent.push(Buffer.from(JSON.parse(init.body).raw,'base64url').toString());return new Response(JSON.stringify({id:'sent'}));};
  try{await run(sent);}finally{globalThis.fetch=oldFetch;for(const[k,val]of Object.entries(previous)){if(val===undefined)delete process.env[k];else process.env[k]=val;}}
}
for(const kind of ['requester_submission_received','requester_approved','requester_rejected','requester_unavailable','approver_conflict_urgent'])test(`${kind} has an outstanding table only when addressed to the submitter`,async()=>gmail(async sent=>{
  const b=booking({startAt:Date.now()+86400000,endAt:Date.now()+86400000+3600000,occurrences:undefined});
  const outstanding=rules.submitterMeetings({...b,_id:'next',eventName:'OUTSTANDING-ROW'});let pages=0;const mutations=[];
  const ctx={runQuery:async(name,args)=>{
    if(name==='getDeliveryContext')return {state:'ready',context:{booking:b,delivery:{_id:'delivery',kind,recipientEmail:'person@example.com'},decisionToken:null,relatedBookings:[]}};
    if(name==='emailPage'){assert.equal(args.email,'person@example.com');pages++;return {page:pages===1?outstanding:[],isDone:pages===2,continueCursor:'page2',timezone:'Asia/Singapore'};}
    throw Error(name);
  },runMutation:async(name,args)=>{mutations.push({name,args});return name==='issueLink'?'a'.repeat(64):undefined;}};
  await emails.sendDelivery.handler(ctx,{deliveryId:'delivery',leaseToken:'lease'});assert.equal(sent.length,1,JSON.stringify(mutations));
  if(kind.startsWith('requester_')){assert.match(sent[0],/OUTSTANDING-ROW/);assert.match(sent[0],/\/booking-calendar/);assert.match(sent[0],/Your outstanding bookings/);assert.equal(pages,2);}else{assert.doesNotMatch(sent[0],/OUTSTANDING-ROW|Your outstanding bookings|\/booking-calendar/);assert.equal(pages,0);}
  assert.equal(mutations.at(-1).name,'completeDelivery');
  if(kind==='requester_approved') {assert.match(sent[0],/booking-request#token=a{64}/);assert.match(sent[0],/Request Changes/);assert.doesNotMatch(sent[0],/booking-request[^\s"<]*bookingId/);}
  else assert.doesNotMatch(sent[0],/booking-request#token=/);
}));
test('deletion notification sends snapshot and saved remaining-bookings footer without needing the deleted row',async()=>gmail(async sent=>{
  const ctx=context();await queueBookingNotice(ctx,booking(),null,'deleted');const noticeId=ctx.rows('bookingNotices')[0]._id;let pages=0;
  ctx.runMutation=async(name,args)=>{if(name==='claim')return notices.claim.handler(ctx,args);if(name==='finish')return notices.finish.handler(ctx,args);throw Error(name);};
  ctx.runQuery=async name=>{assert.equal(name,'emailPage');pages++;return {page:[],isDone:true,continueCursor:'',timezone:'Asia/Singapore'};};
  await emails.sendBookingNotice.handler(ctx,{noticeId});assert.equal(sent.length,1);assert.match(sent[0],/was deleted/);assert.match(sent[0],/Removed meetings/);assert.match(sent[0],/Your outstanding bookings/);assert.match(sent[0],/No bookings in this view/);assert.equal((await ctx.db.get(noticeId)).status,'sent');assert.equal(pages,0);
}));

test('repeated single and following edits keep the latest persisted occurrences in lookup and frozen emails',async()=>{
  const base=Date.now()+10*86400000;
  const b=booking({occurrences:[0,1,2,3,4].map(sequence=>({sequence,startAt:base+sequence*7*86400000,endAt:base+sequence*7*86400000+3600000})),recurrenceCount:5,startAt:base,endAt:base+3600000});
  const ctx=context({bookings:[b]});
  ctx.auth={getUserIdentity:async()=>({email:b.requesterEmail,emailVerified:true})};
  async function edit(scope,sequence,title,hours){
    const current=await ctx.db.get(b._id);const occurrence=current.occurrences.find(row=>row.sequence===sequence);
    await bookings.edit.handler(ctx,{...current,bookingId:b._id,expectedRevision:current.revision,editScope:scope,occurrenceSequence:sequence,eventName:title,startAt:occurrence.startAt+hours*3600000,endAt:occurrence.endAt+hours*3600000,notifySubmitter:true});
  }
  await edit('occurrence',0,'First exception',1);
  await edit('following',2,'Third and later',2);
  const frozen=ctx.rows('bookingNotices')[1].outstandingJson;
  await edit('occurrence',3,'Fourth exception',1);
  await edit('following',2,'Latest tail',1);
  const result=await own.list.handler(ctx,{email:b.requesterEmail,paginationOpts:{numItems:20,cursor:null}});
  const meetings=result.page[0].meetings;
  assert.deepEqual(meetings.map(row=>row.title),['First exception','Meeting','Latest tail','Latest tail','Latest tail']);
  assert.equal(meetings[0].startAt,base+3600000);
  assert.equal(meetings[1].startAt,base+7*86400000);
  assert.equal(meetings[3].startAt,base+21*86400000+4*3600000);
  assert.equal(ctx.rows('bookingNotices')[1].outstandingJson,frozen);
  assert.deepEqual(JSON.parse(frozen).rows.map(row=>row.title),['First exception','Meeting','Third and later','Third and later','Third and later']);
  const current=await ctx.db.get(b._id);
  await bookings.removeOccurrences.handler(ctx,{bookingId:b._id,expectedRevision:current.revision,scope:'following',occurrenceSequence:2,notifySubmitter:true});
  const remaining=await own.list.handler(ctx,{email:b.requesterEmail,paginationOpts:{numItems:20,cursor:null}});
  assert.equal(remaining.page[0].meetings.length,2);
  assert.equal(JSON.parse(ctx.rows('bookingNotices').at(-1).outstandingJson).rows.length,2);
});
test('bulk edits snapshot every changed booking after the whole batch, including dates beyond one year',async()=>{
  const startAt=Date.now()+800*86400000;
  const first=booking({_id:'one',occurrences:undefined,startAt,endAt:startAt+3600000});
  const second=booking({_id:'two',occurrences:undefined,startAt:startAt+86400000,endAt:startAt+86400000+3600000});
  const ctx=context({bookings:[first,second]});
  await bookings.saveTableEdits.handler(ctx,{clientRequestId:'batch-snapshot',notifySubmitter:true,edits:[first,second].map(b=>({bookingId:b._id,expectedRevision:1,requesterName:b.requesterName,requesterEmail:b.requesterEmail,eventName:`Updated ${b._id}`,responseEdits:[]}))});
  assert.equal(ctx.rows('bookingNotices').length,2);
  for(const notice of ctx.rows('bookingNotices'))assert.deepEqual(JSON.parse(notice.outstandingJson).rows.map(row=>row.title),['Updated one','Updated two']);
});
test('successful full deletion snapshot excludes deleted series and preserves other bookings',async()=>{
  const startAt=Date.now()+3*86400000;
  const ctx=context({bookings:[booking({deletionToken:'lease',deletionLeaseExpiresAt:Date.now()+60000}),booking({_id:'survivor',eventName:'Retained',startAt,endAt:startAt+3600000,occurrences:undefined})]});
  await bookings.completeBookingDeletion.handler(ctx,{bookingId:'booking',actorId:'admin',deletionToken:'lease',notifySubmitter:true});
  assert.deepEqual(JSON.parse(ctx.rows('bookingNotices')[0].outstandingJson).rows.map(row=>row.title),['Retained']);
});
test('delayed and retried notices send the saved table without querying changed live bookings',async()=>gmail(async sent=>{
  const startAt=Date.now()+800*86400000;
  const before=booking({occurrences:undefined,startAt,endAt:startAt+3600000});
  const after={...before,eventName:'SAVED-STATE'};const ctx=context({bookings:[after]});
  await queueBookingNotice(ctx,before,after,'edited');const noticeId=ctx.rows('bookingNotices')[0]._id;
  await ctx.db.patch('booking',{eventName:'LATER-STATE'});
  ctx.runQuery=async()=>{throw Error('Must not read live state');};
  ctx.runMutation=async(name,args)=>name==='claim'?notices.claim.handler(ctx,args):notices.finish.handler(ctx,args);
  // Simulate a failed previous send before retrying the durable notice.
  await notices.claim.handler(ctx,{noticeId,token:'failed'});
  await notices.finish.handler(ctx,{noticeId,token:'failed',error:'Temporary Gmail failure'});
  await emails.sendBookingNotice.handler(ctx,{noticeId});
  assert.equal(sent.length,1);assert.match(sent[0],/Snapshot when your change was saved/);assert.doesNotMatch(sent[0],/LATER-STATE/);
  assert.ok(sent[0].split('SAVED-STATE').length>=3);assert.equal((await ctx.db.get(noticeId)).status,'sent');
}));
const calendar=await import('../convex/lib/bookingCalendar.ts');
test('calendar grid and month navigation handle leap years and year boundaries',()=>{
  assert.equal(calendar.shiftMonth('2026-12',1),'2027-01');assert.equal(calendar.shiftMonth('2026-01',-1),'2025-12');
  const days=calendar.monthDays('2024-02');assert.equal(days.length,42);assert.equal(new Date(days[0]).getUTCDay(),0);assert.ok(days.includes('2024-02-29'));assert.equal(new Set(days).size,42);
});
test('calendar day membership includes multi-day meetings, excludes exclusive midnight end, and respects venue timezone',()=>{
  const rows=rules.submitterMeetings(booking({occurrences:undefined,startAt:Date.parse('2026-09-17T15:00:00Z'),endAt:Date.parse('2026-09-18T16:00:00Z')}));
  assert.equal(calendar.meetingsOnDay(rows,'2026-09-17','Asia/Singapore').length,1);
  assert.equal(calendar.meetingsOnDay(rows,'2026-09-18','Asia/Singapore').length,1);
  assert.equal(calendar.meetingsOnDay(rows,'2026-09-19','Asia/Singapore').length,0);
});

test('whole-series edit replaces earlier title exceptions and a later single cancellation disappears from both views',async()=>{
  const base=Date.now()+20*86400000;
  const b=booking({startAt:base,endAt:base+3600000,occurrences:[0,1,2].map(sequence=>({sequence,startAt:base+sequence*7*86400000,endAt:base+sequence*7*86400000+3600000,details:{eventName:'Old exception'}}))});
  const ctx=context({bookings:[b]});
  await bookings.edit.handler(ctx,{...b,bookingId:b._id,expectedRevision:1,editScope:'series',eventName:'New entire series',notifySubmitter:true});
  let current=await ctx.db.get(b._id);
  assert.ok(rules.submitterMeetings(current).every(row=>row.title==='New entire series'));
  const removedDay=rules.dateKey(current.occurrences[1].startAt,'Asia/Singapore');
  await bookings.removeOccurrences.handler(ctx,{bookingId:b._id,expectedRevision:current.revision,scope:'occurrence',occurrenceSequence:current.occurrences[1].sequence,notifySubmitter:true});
  current=await ctx.db.get(b._id);
  const rows=rules.submitterMeetings(current);
  assert.equal(rows.length,2);assert.equal(calendar.meetingsOnDay(rows,removedDay,'Asia/Singapore').length,0);
  assert.equal(JSON.parse(ctx.rows('bookingNotices').at(-1).outstandingJson).rows.length,2);
});
test('legacy queued notices without a snapshot still deliver using a clearly labelled send-time table',async()=>gmail(async sent=>{
  const ctx=context();await queueBookingNotice(ctx,booking(),null,'deleted');const noticeId=ctx.rows('bookingNotices')[0]._id;
  await ctx.db.patch(noticeId,{outstandingJson:undefined});
  ctx.runMutation=async(name,args)=>name==='claim'?notices.claim.handler(ctx,args):notices.finish.handler(ctx,args);
  ctx.runQuery=async()=>({page:[],isDone:true,continueCursor:'',timezone:'Asia/Singapore'});
  await emails.sendBookingNotice.handler(ctx,{noticeId});assert.equal(sent.length,1);assert.match(sent[0],/Snapshot at email sending time/);
}));

const publicRules=await import('../convex/lib/publicBookings.ts');
test('public booking queries work anonymously and return only approved allowlisted fields',async()=>{
  const ctx=context({bookings:['approved','pending','rejected','unavailable','processing'].map(status=>booking({_id:status,status,ministry:'Youth',purpose:'PRIVATE-PURPOSE',requesterName:'PRIVATE-NAME',requesterEmail:'PRIVATE-EMAIL',formResponses:[{value:'PRIVATE-ANSWER'}],calendarSyncError:'PRIVATE-ERROR'}))});
  ctx.auth={getUserIdentity:async()=>{throw Error('Public queries must not require identity');}};
  for(const status of ['approved']) {
    const result=await own.publicList.handler(ctx,{status,paginationOpts:{numItems:20,cursor:null}});
    assert.equal(result.page.length,1);assert.equal(result.page[0].id,status);
    assert.equal(result.page[0].meetings.length,3);
    for(const row of result.page[0].meetings){
      assert.equal(row.status,status);
      assert.deepEqual(Object.keys(row).sort(),['key','title','room','rooms','ministry','status','startAt','endAt','timezone'].sort());
    }
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE-|requester|purpose|formResponses|reference|submittedAt|calendarSync/);
  }
  assert.deepEqual((await own.publicList.handler(ctx,{status:'pending',paginationOpts:{numItems:20,cursor:null}})).page,[]);
  await assert.rejects(own.publicList.handler(ctx,{status:'rejected',paginationOpts:{numItems:20,cursor:null}}));
  assert.ok((await own.publicSettings.handler(ctx,{})).timezone);
});
test('public projection omits every nonpublic status and handles scoped ministry/room changes',()=>{
  for(const status of ['pending','rejected','unavailable','processing','unknown'])assert.deepEqual(publicRules.publicMeetings(booking({status})),[]);
  const b=booking({status:'approved',ministry:'Youth',resolvedVenues:['Room A','Room B']});
  b.occurrences[1]={...b.occurrences[1],room:'Room C',resolvedVenues:['Room C'],details:{ministry:'Children',eventName:'Current title'}};
  b.occurrences[2]={...b.occurrences[2],details:{ministry:''}};
  const rows=publicRules.publicMeetings(b);
  assert.equal(rows[0].ministry,'Youth');assert.deepEqual(rows[0].rooms,['Room A','Room B']);
  assert.equal(rows[1].ministry,'Children');assert.equal(rows[1].room,'Room C');assert.equal(rows[1].title,'Current title');assert.deepEqual(rows[1].rooms,['Room C']);
  assert.equal(rows[2].ministry,'');
});
test('public ministry and room filters combine and reject stale pending rows',()=>{
  const rows=[['a','Youth','A'],['b','Youth','B'],['c','Children','A']].flatMap(([id,ministry,room])=>publicRules.publicMeetings(booking({_id:id,status:'approved',ministry,room,occurrences:undefined})));
  const filter=extra=>publicRules.filterPublicMeetings(rows,{ministries:[],rooms:[],...extra}).map(row=>row.key);
  assert.deepEqual(filter({}),['a:0','b:0','c:0']);
  assert.deepEqual(filter({ministries:['Youth']}),['a:0','b:0']);
  assert.deepEqual(filter({rooms:['A']}),['a:0','c:0']);
  assert.deepEqual(filter({ministries:['Youth'],rooms:['A']}),['a:0']);
  assert.deepEqual(filter({ministries:['Youth','Children'],rooms:['A','B']}),['a:0','b:0','c:0']);
  assert.deepEqual(filter({rooms:['missing']}),[]);
  assert.deepEqual(publicRules.filterPublicMeetings([{...rows[0],status:'pending'}],{ministries:[],rooms:[]}),[]);
});
test('public filters match combined venue components and unspecified ministries without a date limit',()=>{
  const rows=publicRules.publicMeetings(booking({status:'approved',occurrences:undefined,room:'A & B',resolvedVenues:['A','B'],ministry:undefined,startAt:Date.now()+1000*86400000}));
  for(const room of ['A','B','A & B'])assert.equal(publicRules.filterPublicMeetings(rows,{ministries:[''],rooms:[room]}).length,1);
  assert.equal(calendar.meetingsOnDay(rows,rules.dateKey(rows[0].startAt,rows[0].timezone),rows[0].timezone).length,1);
});
test('public queries preserve pagination and immediately reflect persisted edits, cancellations, and status changes',async()=>{
  const ctx=context({bookings:[booking({_id:'first',status:'approved',ministry:'Old'}),booking({_id:'second',status:'approved'})]});
  const first=await own.publicList.handler(ctx,{paginationOpts:{numItems:1,cursor:null}});
  assert.equal(first.page.length,1);assert.equal(first.isDone,false);
  const b=await ctx.db.get('first');
  await ctx.db.patch('first',{occurrences:b.occurrences.slice(1).map(row=>({...row,room:'Updated room',details:{ministry:'Updated ministry',eventName:'Updated event'}}))});
  const updated=await own.publicList.handler(ctx,{paginationOpts:{numItems:20,cursor:null}});
  const meetings=updated.page.find(row=>row.id==='first').meetings;
  assert.equal(meetings.length,2);assert.ok(meetings.every(row=>row.ministry==='Updated ministry'&&row.title==='Updated event'&&row.room==='Updated room'));
  await ctx.db.patch('first',{status:'pending'});
  const rejected=await own.publicList.handler(ctx,{paginationOpts:{numItems:20,cursor:null}});
  assert.equal(rejected.page.some(row=>row.id==='first'),false);
  await ctx.db.delete('second');
  assert.equal((await own.publicList.handler(ctx,{paginationOpts:{numItems:20,cursor:null}})).page.length,0);
});

test('calendar previews show both start and end times in the booking timezone',()=>{
  const startAt=Date.parse('2026-09-17T01:30:00Z'),endAt=Date.parse('2026-09-17T03:00:00Z');
  const format=new Intl.DateTimeFormat('en-SG',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Singapore'});
  assert.equal(calendar.calendarTimeRange({startAt,endAt},'Asia/Singapore'),`${format.format(startAt)} – ${format.format(endAt)}`);
});
test('overnight and midnight-ending calendar previews identify both endpoint dates',()=>{
  for(const end of ['2026-09-17T16:00:00Z','2026-09-18T01:00:00Z']){
    const startAt=Date.parse('2026-09-17T15:00:00Z'),endAt=Date.parse(end);
    const format=new Intl.DateTimeFormat('en-SG',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Singapore',day:'numeric',month:'short'});
    assert.equal(calendar.calendarTimeRange({startAt,endAt},'Asia/Singapore'),`${format.format(startAt)} – ${format.format(endAt)}`);
  }
});

test('calendar day and week navigation crosses month/year/leap boundaries',()=>{
  assert.equal(calendar.shiftDay('2026-12-31',1),'2027-01-01');
  assert.equal(calendar.shiftDay('2024-03-01',-1),'2024-02-29');
  assert.deepEqual(calendar.weekDays('2026-09-17'),['2026-09-13','2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-19']);
  assert.equal(calendar.weekDays('2027-01-01')[0],'2026-12-27');
});
test('hourly layout separates overlap groups and reuses lanes for adjacent events',()=>{
  const row=(key,start,end)=>({key,startAt:Date.parse(`2026-09-17T${start}:00+08:00`),endAt:Date.parse(`2026-09-17T${end}:00+08:00`)});
  const blocks=calendar.timelineMeetings([row('a','09:00','11:00'),row('b','10:00','12:00'),row('c','11:00','12:00'),row('d','12:00','13:00')],'2026-09-17','Asia/Singapore');
  assert.deepEqual(blocks.map(b=>[b.start,b.end,b.lane,b.lanes]),[[540,660,0,2],[600,720,1,2],[660,720,0,2],[720,780,0,1]]);
});
test('timeline clips overnight meetings and keeps midnight end exclusive',()=>{
  const row={key:'overnight',startAt:Date.parse('2026-09-17T23:00:00+08:00'),endAt:Date.parse('2026-09-19T00:00:00+08:00')};
  const first=calendar.timelineMeetings([row],'2026-09-17','Asia/Singapore')[0];
  const next=calendar.timelineMeetings([row],'2026-09-18','Asia/Singapore')[0];
  assert.deepEqual([first.start,first.end,next.start,next.end],[1380,1440,0,1440]);
  assert.deepEqual(calendar.timelineMeetings([row],'2026-09-19','Asia/Singapore'),[]);
});
test('short events reserve visible space without overlapping the next visual lane',()=>{
  const start=Date.parse('2026-09-17T09:00:00+08:00');
  const blocks=calendar.timelineMeetings([{key:'a',startAt:start,endAt:start+60000},{key:'b',startAt:start+120000,endAt:start+180000}],'2026-09-17','Asia/Singapore');
  assert.equal(blocks[0].end-blocks[0].start,30);assert.equal(blocks[0].lanes,2);assert.notEqual(blocks[0].lane,blocks[1].lane);
});

const listRules=await import('../convex/lib/bookingList.ts');
test('booking list always has a today anchor between sorted past and future groups',()=>{
  const row=(key,date)=>({...publicRules.publicMeetings(booking({status:'approved',occurrences:undefined}))[0],key,startAt:Date.parse(`${date}T09:00:00+08:00`),endAt:Date.parse(`${date}T10:00:00+08:00`)});
  const groups=listRules.bookingListGroups([row('future','2026-09-19'),row('past','2026-09-16')],'2026-09-17','Asia/Singapore');
  assert.deepEqual(groups.map(group=>group.day),['2026-09-16','2026-09-17','2026-09-19']);
  assert.deepEqual(groups[1].meetings,[]);
  assert.deepEqual(listRules.bookingListGroups([],'2026-09-17','Asia/Singapore'),[{day:'2026-09-17',meetings:[]}]);
});
test('list includes overnight ongoing events today but excludes events ending at local midnight',()=>{
  const base=publicRules.publicMeetings(booking({status:'approved',occurrences:undefined}))[0];
  const startAt=Date.parse('2026-09-16T23:00:00+08:00');
  const rows=[{...base,key:'continuing',startAt,endAt:Date.parse('2026-09-17T01:00:00+08:00')},{...base,key:'ended',startAt,endAt:Date.parse('2026-09-17T00:00:00+08:00')}];
  const groups=listRules.bookingListGroups(rows,'2026-09-17','Asia/Singapore');
  assert.equal(groups[0].meetings.length,2);
  assert.deepEqual(groups[1].meetings.map(row=>row.key),['continuing']);
});

const googlePublic=await import('../convex/lib/googlePublicCalendar.ts');
const googleSchedule=await import('../convex/publicCalendar.ts');
const googleClientModule=await import('../convex/lib/googleCalendar.ts');
function googleEvent(extra={}){return {id:'event',summary:'Google title',status:'confirmed',start:{dateTime:'2026-09-18T19:00:00+08:00'},end:{dateTime:'2026-09-18T22:30:00+08:00'},...extra};}
test('Google projection uses Google title/time, removes cancelled entries and redacts private details',()=>{
  const event=googleEvent({description:'SECRET',attendees:[{email:'SECRET'}]});
  const row=googlePublic.projectGoogleEvent(event,'opaque',['Shema Space'],'Asia/Singapore','Youth');
  assert.equal(row.title,'Google title');assert.equal(row.startAt,Date.parse(event.start.dateTime));assert.equal(row.source,'google');assert.equal(row.googleStatus,'confirmed');assert.doesNotMatch(JSON.stringify(row),/SECRET|description|attendees/);
  assert.equal(googlePublic.projectGoogleEvent({status:'cancelled'},'key',[],'Asia/Singapore'),null);
  for(const visibility of ['private','confidential']){const hidden=googlePublic.projectGoogleEvent({...event,visibility},'key',['Room'],'Asia/Singapore','Youth');assert.equal(hidden.title,'Busy');assert.equal(hidden.ministry,'');}
  assert.equal(googlePublic.projectGoogleEvent(googleEvent({status:'tentative'}),'key',[],'Asia/Singapore').googleStatus,'tentative');
});
test('Google all-day events use local midnight and exclusive end, including DST',()=>{
  const row=googlePublic.projectGoogleEvent(googleEvent({start:{date:'2026-09-18'},end:{date:'2026-09-20'}}),'key',['Room'],'Asia/Singapore');
  assert.equal(row.startAt,Date.parse('2026-09-17T16:00:00Z'));assert.equal(row.endAt,Date.parse('2026-09-19T16:00:00Z'));assert.equal(row.allDay,true);
  assert.equal(googlePublic.midnightInZone('2026-03-09','America/New_York'),Date.parse('2026-03-09T04:00:00Z'));
  assert.throws(()=>googlePublic.projectGoogleEvent(googleEvent({end:{dateTime:'bad'}}),'key',[],'Asia/Singapore'));
});
test('Google public ranges cover a complete month grid with no one-year limit',()=>{
  assert.equal(googlePublic.publicCalendarRange('2028-02').firstDay,'2028-01-30');
  assert.equal(googlePublic.publicCalendarRange('2028-02').lastDay,'2028-03-11');
  for(const month of ['bad','2026-13','2026-00'])assert.throws(()=>googlePublic.publicCalendarRange(month));
});
test('Google schedule reads expanded instances across every page and rejects partial permissions or repeated tokens',async()=>{
  function client(pages){const calls=[];const c=new googleClientModule.GoogleCalendarClient({credentials:{},maxAttempts:1,fetch:async url=>{calls.push(new URL(url));return new Response(JSON.stringify(pages.shift()));}});c.accessToken={value:'fake',expiresAt:Date.now()+3600000};return {c,calls};}
  const {c,calls}=client([{accessRole:'reader',items:[],nextPageToken:'next'},{accessRole:'reader',items:[googleEvent()]}]);
  assert.equal((await c.listPublicSchedule('calendar','2026-09-01T00:00:00Z','2026-10-01T00:00:00Z','Asia/Singapore')).length,1);
  assert.equal(calls[0].searchParams.get('singleEvents'),'true');assert.equal(calls[0].searchParams.get('showDeleted'),'false');assert.equal(calls[1].searchParams.get('pageToken'),'next');assert.equal(calls[0].searchParams.has('privateExtendedProperty'),false);
  for(const pages of [[{accessRole:'freeBusyReader',items:[]}],[{accessRole:'reader',nextPageToken:'x'},{accessRole:'reader',nextPageToken:'x'}]])await assert.rejects(client(pages).c.listPublicSchedule('c','2026-09-01T00:00:00Z','2026-10-01T00:00:00Z','Asia/Singapore'));
});
test('Google cache leases prevent duplicate reads, replace deleted events and retain stale snapshots on failure',async()=>{
  const ctx=context();
  assert.equal((await googleSchedule.claim.handler(ctx,{key:'month',token:'one'})).fetch,true);
  assert.equal((await googleSchedule.claim.handler(ctx,{key:'month',token:'two'})).fetch,false);
  await googleSchedule.finish.handler(ctx,{key:'month',token:'one',json:'[{"key":"old"}]'});
  const saved=ctx.rows('publicCalendarCache').find(x=>x.key==='month');await ctx.db.patch(saved._id,{retryAt:0});await ctx.db.patch(ctx.rows('publicCalendarCache').find(x=>x.key==='global')._id,{retryAt:0});
  await googleSchedule.claim.handler(ctx,{key:'month',token:'three'});
  assert.equal(await googleSchedule.finish.handler(ctx,{key:'month',token:'stale',json:'[]'}),null);
  await googleSchedule.finish.handler(ctx,{key:'month',token:'three',error:'Failed'});
  assert.equal((await ctx.db.get(saved._id)).json,'[{"key":"old"}]');
  await ctx.db.patch(saved._id,{retryAt:0});await ctx.db.patch(ctx.rows('publicCalendarCache').find(x=>x.key==='global')._id,{retryAt:0});
  await googleSchedule.claim.handler(ctx,{key:'month',token:'four'});await googleSchedule.finish.handler(ctx,{key:'month',token:'four',json:'[]'});
  assert.equal((await ctx.db.get(saved._id)).json,'[]');assert.equal((await ctx.db.get(saved._id)).error,undefined);
});
test('public Google action displays external events, reuses cache and never publishes a partial refresh',async()=>{
  const names=['GOOGLE_CALENDAR_ENABLED','GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64','GOOGLE_CALENDAR_VENUE_MAP_JSON','BOOKING_TIME_ZONE'];
  const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));const original=googleClientModule.GoogleCalendarClient.prototype.listPublicSchedule;
  try{
    process.env.GOOGLE_CALENDAR_ENABLED='true';process.env.BOOKING_TIME_ZONE='Asia/Singapore';
    process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64=Buffer.from(JSON.stringify({client_email:'calendar@example.com',private_key:'-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'})).toString('base64');
    process.env.GOOGLE_CALENDAR_VENUE_MAP_JSON=JSON.stringify(Object.fromEntries(googleClientModule.GOOGLE_CALENDAR_VENUES.map((venue,i)=>[venue,`calendar-${i}`])));
    const ctx=context();ctx.runMutation=async(name,args)=>googleSchedule[name].handler(ctx,args);ctx.runQuery=async()=>{throw Error('External events must not require a RoomOps row');};
    let calls=0;googleClientModule.GoogleCalendarClient.prototype.listPublicSchedule=async function(){calls++;return [googleEvent()];};
    const result=await googleSchedule.read.handler(ctx,{month:'2026-09'});
    assert.equal(result.error,null);assert.equal(result.rows.length,7);assert.equal(new Set(result.rows.map(row=>row.key)).size,7);assert.equal(calls,7);
    assert.ok(result.rows.every(row=>row.title==='Google title'&&row.ministry===''));
    await googleSchedule.read.handler(ctx,{month:'2026-09'});assert.equal(calls,7);
    for(const row of ctx.rows('publicCalendarCache'))await ctx.db.patch(row._id,{retryAt:0});
    calls=0;googleClientModule.GoogleCalendarClient.prototype.listPublicSchedule=async function(){if(++calls===2)throw Error('private details must not escape');return [googleEvent({summary:'PARTIAL'})];};
    const failed=await googleSchedule.read.handler(ctx,{month:'2026-09'});
    assert.ok(failed.error);assert.equal(failed.rows.length,7);assert.equal(failed.fetchedAt,result.fetchedAt);assert.doesNotMatch(JSON.stringify(failed),/PARTIAL|private details/);
  }finally{googleClientModule.GoogleCalendarClient.prototype.listPublicSchedule=original;for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}}
});
test('Google-linked ministry lookup respects scoped overrides and avoids guessing after an external move',async()=>{
  const b=booking({status:'approved',ministry:'Base'});b.occurrences[1].details={ministry:'Scoped'};
  const ctx=context({bookings:[b]});ctx.db.normalizeId=(_,id)=>id==='booking'?id:null;
  assert.equal(await googleSchedule.ministry.handler(ctx,{bookingId:'booking',startAt:b.occurrences[1].startAt}),'Scoped');
  assert.equal(await googleSchedule.ministry.handler(ctx,{bookingId:'booking',startAt:0}),'');
  assert.equal(await googleSchedule.ministry.handler(ctx,{bookingId:'invalid',startAt:0}),'');
});

for (const admin of [false,true]) test(`request lifecycle emails reuse template and ${admin?'exclude':'include'} outstanding snapshot`,async()=>gmail(async sent=>{
  const ctx=context();const before=rules.submitterMeetings(booking());
  const noticeId=await ctx.db.insert('bookingNotices',{bookingReference:'123',recipientEmail:admin?'admin@example.com':'person@example.com',kind:'edited',scope:'occurrence',beforeJson:JSON.stringify(before),afterJson:JSON.stringify(before.map(row=>({...row,title:'Changed event'}))),detailChanges:'Room: Old → New\n<script>bad</script>',requestSubject:'Booking Change Request Received',requestText:'Awaiting approval.',approverNotice:admin,outstandingJson:JSON.stringify({capturedAt:now,timezone:'Asia/Singapore',rows:before}),calendarPending:false,status:'pending',attempts:0,createdAt:now,updatedAt:now});
  ctx.runMutation=async(name,args)=>notices[name].handler(ctx,args);
  ctx.runQuery=async()=>{throw Error('Must use committed snapshot');};
  await emails.sendBookingNotice.handler(ctx,{noticeId});assert.equal(sent.length,1);
  assert.match(sent[0],/Living Waters Methodist Church/);assert.match(sent[0],/Changed event/);assert.match(sent[0],/&lt;script&gt;bad&lt;\/script&gt;/);
  if(admin){assert.doesNotMatch(sent[0],/Your outstanding bookings/);assert.match(sent[0],/\/booking-requests/);}
  else assert.match(sent[0],/Your outstanding bookings/);
  assert.equal((await ctx.db.get(noticeId)).status,'sent');
}));
