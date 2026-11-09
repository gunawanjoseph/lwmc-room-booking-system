import './roomops-regression-hooks.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const jotform = await import('../convex/jotform.ts');
const bookings = await import('../convex/bookings.ts');
const logs = await import('../convex/logs.ts');
const {completeJotformProcessing} = await import('../convex/lib/jotformProcessing.ts');
const {jotformProcessingLabel} = await import('../shared/jotformRetry.ts');
const start = Date.parse('2026-11-09T11:28:00Z');
const minute = 60_000;
process.env.JOTFORM_FORM_ID = 'form';
process.env.DEVELOPER_EMAIL = 'developer@example.com';

function context(extra = {}) {
  const tables = new Map(Object.entries({externalSubmissions: [{
    _id: 'receipt', provider: 'jotform', formId: 'form', submissionId: 'submission',
    state: 'received', attempts: 0, deliveryCount: 1, firstReceivedAt: start, lastReceivedAt: start,
    ...extra,
  }]}));
  const jobs = [];
  const rows = name => { if (!tables.has(name)) tables.set(name, []); return tables.get(name); };
  const db = {
    get: async id => structuredClone([...tables.values()].flat().find(row => row._id === id) ?? null),
    patch: async (id, patch) => {
      const row = [...tables.values()].flat().find(row => row._id === id);
      assert.ok(row); Object.assign(row, patch);
    },
    insert: async (name, data) => {
      const id = `${name}-${rows(name).length}`; rows(name).push({_id:id, ...data}); return id;
    },
    query: name => {
      let selected = [...rows(name)];
      const chain = {
        withIndex: (_, fn) => { const range = {eq:(key, value) => {selected = selected.filter(row => row[key] === value); return range;}}; fn?.(range); return chain; },
        order: () => chain, unique: async () => selected[0] ?? null, take: async n => selected.slice(0,n),
      };
      return chain;
    },
  };
  return {db, rows, jobs, scheduler: {runAfter: async (delay, name, args) => jobs.push({at:Date.now()+delay, name, args})}};
}

async function withClock(run) {
  const original = Date.now;
  let now = start;
  Date.now = () => now;
  try { await run(at => {now = at;}); } finally {Date.now = original;}
}
const receipt = ctx => ctx.db.get('receipt');
async function fail(ctx) {
  await jotform.markFailed.handler(ctx, {receiptId:'receipt', processingToken:(await receipt(ctx)).processingToken, errorMessage:'JOTFORM_API_ERROR:401:Unauthorized'});
}

test('six attempts use absolute 0, 1, 6, 15, 30, 60 minute offsets and then stop', async () => withClock(async setTime => {
  const ctx = context();
  const offsets = [0, 1, 6, 15, 30, 60];
  for (let i=0; i<offsets.length; i++) {
    setTime(start + offsets[i]*minute);
    if (i) await jotform.resetAndProcess.handler(ctx, {receiptId:'receipt', failedAttempt:i, retryRun:0});
    await jotform.dispatchSubmission.handler(ctx, {receiptId:'receipt', retryRun:0});
    assert.equal((await receipt(ctx)).attempts, i+1);
    setTime(start + offsets[i]*minute + 2_000); // API response time must not accumulate drift.
    await fail(ctx);
    const saved = await receipt(ctx);
    assert.equal(saved.nextRetryAt, i<5 ? start+offsets[i+1]*minute : undefined);
  }
  assert.equal(ctx.jobs.filter(job => job.name === 'resetAndProcess').length, 5);
  assert.equal(ctx.rows('techAlertDeliveries').length, 2); // 15-minute attention and final exhaustion.
  assert.equal(ctx.rows('auditLogs').at(-1).level, 'error');
  assert.equal(jotformProcessingLabel(await receipt(ctx)), 'Needs attention');
  const jobs = ctx.jobs.length;
  await jotform.resetAndProcess.handler(ctx, {receiptId:'receipt',failedAttempt:6,retryRun:0});
  await jotform.queueSubmission.handler(ctx,{formId:'form',submissionId:'submission'});
  assert.equal(ctx.jobs.length, jobs);
}));

test('duplicate webhooks and early timers do not bring a scheduled retry forward', async () => withClock(async () => {
  const ctx = context();
  await jotform.dispatchSubmission.handler(ctx,{receiptId:'receipt'}); await fail(ctx);
  const jobs = ctx.jobs.length;
  await jotform.queueSubmission.handler(ctx,{formId:'form',submissionId:'submission'});
  await jotform.resetAndProcess.handler(ctx,{receiptId:'receipt',failedAttempt:1});
  assert.equal(ctx.jobs.length,jobs); assert.equal((await receipt(ctx)).state,'failed');
  assert.equal(jotformProcessingLabel(await receipt(ctx)), 'Retrying automatically');
  assert.equal(ctx.rows('techAlertDeliveries').length,0);
}));

test('manual retry starts a new run and fences old timers, workers, and attention alerts', async () => withClock(async setTime => {
  const ctx = context();
  await jotform.dispatchSubmission.handler(ctx,{receiptId:'receipt'});
  const oldToken = (await receipt(ctx)).processingToken; await fail(ctx);
  await jotform.retryBySubmissionId.handler(ctx,{submissionId:'submission'});
  await jotform.dispatchSubmission.handler(ctx,{receiptId:'receipt',retryRun:1});
  assert.notEqual((await receipt(ctx)).processingToken,oldToken); // Even in the same millisecond.
  await jotform.markFailed.handler(ctx,{receiptId:'receipt',processingToken:oldToken,errorMessage:'late'});
  assert.equal((await receipt(ctx)).state,'processing');
  await fail(ctx);
  const jobs = ctx.jobs.length;
  setTime(start+15*minute);
  await jotform.resetAndProcess.handler(ctx,{receiptId:'receipt',failedAttempt:1,retryRun:0});
  await jotform.flagDelayedSubmission.handler(ctx,{receiptId:'receipt',retryRun:0});
  assert.equal(ctx.jobs.length,jobs); assert.equal((await receipt(ctx)).attempts,1);
  assert.equal((await receipt(ctx)).attentionNotifiedAt,undefined);
}));

test('manual retry cannot interrupt an active worker or restart a completed receipt', async () => withClock(async () => {
  const ctx=context(); await jotform.dispatchSubmission.handler(ctx,{receiptId:'receipt'});
  await assert.rejects(jotform.retryBySubmissionId.handler(ctx,{submissionId:'submission'}),/already being processed/);
  await completeJotformProcessing(ctx,await receipt(ctx),start);
  const jobs=ctx.jobs.length;
  assert.deepEqual(await jotform.retryBySubmissionId.handler(ctx,{submissionId:'submission'}),{state:'processed',alreadyProcessed:true});
  assert.equal(ctx.jobs.length,jobs);
}));

test('a manual retry of an old exhausted receipt gets a fresh schedule and retains recovery history', async () => withClock(async setTime => {
  const ctx=context({state:'failed',attempts:3,lastError:'Unauthorized'});
  const later=start+2*60*minute; setTime(later);
  await jotform.retryBySubmissionId.handler(ctx,{submissionId:'submission'});
  await jotform.dispatchSubmission.handler(ctx,{receiptId:'receipt',retryRun:1});
  await fail(ctx);
  assert.equal((await receipt(ctx)).retryStartedAt,later);
  assert.equal((await receipt(ctx)).nextRetryAt,later+minute);
  setTime(later+minute);
  await jotform.resetAndProcess.handler(ctx,{receiptId:'receipt',failedAttempt:1,retryRun:1});
  await jotform.dispatchSubmission.handler(ctx,{receiptId:'receipt',retryRun:1});
  await completeJotformProcessing(ctx,await receipt(ctx),Date.now());
  assert.equal(jotformProcessingLabel(await receipt(ctx)),'Recovered after retry');
}));

test('attention is raised once at 15 minutes and suppressed after recovery', async () => withClock(async setTime => {
  const ctx=context(); await jotform.dispatchSubmission.handler(ctx,{receiptId:'receipt'}); await fail(ctx);
  setTime(start+15*minute-1); await jotform.flagDelayedSubmission.handler(ctx,{receiptId:'receipt',retryRun:0});
  assert.equal(ctx.rows('techAlertDeliveries').length,0);
  setTime(start+15*minute); await jotform.flagDelayedSubmission.handler(ctx,{receiptId:'receipt',retryRun:0});
  await jotform.flagDelayedSubmission.handler(ctx,{receiptId:'receipt',retryRun:0});
  assert.equal(ctx.rows('techAlertDeliveries').length,1);
  const saved=await receipt(ctx); await completeJotformProcessing(ctx,saved,Date.now());
  await jotform.flagDelayedSubmission.handler(ctx,{receiptId:'receipt',retryRun:0});
  assert.equal(ctx.rows('techAlertDeliveries').length,1);
  assert.equal(jotformProcessingLabel(await receipt(ctx)),'Recovered after retry');
  assert.equal((await receipt(ctx)).nextRetryAt,undefined);
}));

test('expired worker leases follow the same retry schedule and ignore stale owners', async () => withClock(async setTime => {
  const ctx=context({state:'processing',attempts:3,retryStartedAt:start,processingStartedAt:start+6*minute,processingToken:'owner'});
  setTime(start+11*minute);
  await jotform.recoverProcessingLease.handler(ctx,{receiptId:'receipt',processingToken:'old'});
  assert.equal((await receipt(ctx)).state,'processing');
  await jotform.recoverProcessingLease.handler(ctx,{receiptId:'receipt',processingToken:'owner'});
  assert.equal((await receipt(ctx)).nextRetryAt,start+15*minute);
  assert.equal((await receipt(ctx)).state,'failed');
}));

test('successful finalization clears retry state and logs recovery only once', async () => withClock(async () => {
  const ctx=context({state:'processing',attempts:4,failureCount:3,processingToken:'worker',bookingId:'booking',nextRetryAt:start+30*minute});
  ctx.rows('bookings').push({_id:'booking',jotformFormId:'form',jotformSubmissionId:'submission',status:'pending',availabilityCheckPending:false});
  const args={receiptId:'receipt',processingToken:'worker',bookingId:'booking',calendarIntegrationEnabled:false,calendarAvailabilityStatus:'unchecked'};
  await bookings.finalizeJotformSubmission.handler(ctx,args);
  assert.equal((await receipt(ctx)).state,'processed');
  assert.equal((await receipt(ctx)).recoveredAt,start);
  await assert.rejects(bookings.finalizeJotformSubmission.handler(ctx,args),/no longer owns/);
  assert.equal(ctx.rows('auditLogs').filter(log=>log.action==='submission_recovered').length,1);
}));

test('system logs display live recovery on older failure entries', async () => withClock(async () => {
  const ctx=context({state:'processed',attempts:2,recoveredAt:start});
  ctx.rows('auditLogs').push({_id:'old',category:'jotform',action:'submission_processing_failed',entityType:'jotform_submission',entityId:'submission'});
  const result=await logs.list.handler(ctx,{limit:100});
  assert.equal(jotformProcessingLabel(result[0].jotformProcessing),'Recovered after retry');
  assert.equal(result[0].action,'submission_processing_failed'); // Keep the historical evidence.
}));
