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
test('outstanding starts at local midnight and includes the anniversary date',()=>{
  assert.deepEqual(rules.bookingWindow(now),{today:'2026-09-18',until:'2027-09-18',timezone:'Asia/Singapore'});
  const starts=['2026-09-17T15:59:59Z','2026-09-17T16:00:00Z','2027-09-18T15:59:59Z','2027-09-18T16:00:00Z'].map(Date.parse);
  const rows=starts.flatMap((startAt,i)=>rules.submitterMeetings(booking({_id:String(i),startAt,endAt:startAt+1000,occurrences:undefined})));
  assert.deepEqual(rules.filterMeetings(rows,'outstanding',now,'Asia/Singapore').map(x=>x.key),['1:0','2:0']);
});
test('leap-day anniversary clamps to February 28',()=>{
  assert.equal(rules.bookingWindow(Date.parse('2024-02-29T04:00:00Z')).until,'2025-02-28');
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
  },runMutation:async(name,args)=>mutations.push({name,args})};
  await emails.sendDelivery.handler(ctx,{deliveryId:'delivery',leaseToken:'lease'});assert.equal(sent.length,1,JSON.stringify(mutations));
  if(kind.startsWith('requester_')){assert.match(sent[0],/OUTSTANDING-ROW/);assert.match(sent[0],/\/my-bookings/);assert.match(sent[0],/Your outstanding bookings/);assert.equal(pages,2);}else{assert.doesNotMatch(sent[0],/OUTSTANDING-ROW|Your outstanding bookings|\/my-bookings/);assert.equal(pages,0);}
  assert.equal(mutations.at(-1).name,'completeDelivery');
}));
test('deletion notification sends snapshot and live remaining-bookings footer without needing the deleted row',async()=>gmail(async sent=>{
  const ctx=context();await queueBookingNotice(ctx,booking(),null,'deleted');const noticeId=ctx.rows('bookingNotices')[0]._id;let pages=0;
  ctx.runMutation=async(name,args)=>{if(name==='claim')return notices.claim.handler(ctx,args);if(name==='finish')return notices.finish.handler(ctx,args);throw Error(name);};
  ctx.runQuery=async name=>{assert.equal(name,'emailPage');pages++;return {page:[],isDone:true,continueCursor:'',timezone:'Asia/Singapore'};};
  await emails.sendBookingNotice.handler(ctx,{noticeId});assert.equal(sent.length,1);assert.match(sent[0],/was deleted/);assert.match(sent[0],/Removed meetings/);assert.match(sent[0],/Your outstanding bookings/);assert.match(sent[0],/No bookings in this view/);assert.equal((await ctx.db.get(noticeId)).status,'sent');assert.equal(pages,1);
}));
