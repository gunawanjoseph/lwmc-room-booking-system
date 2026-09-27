import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import type { Doc } from "../_generated/dataModel";
import { requestCandidate } from "./requesterWorkflow";
import { expandRecurrence, type RecurrenceFrequency } from "./recurrence";
const zone = "Asia/Singapore";
const at = (date: string) => DateTime.fromISO(`${date}T14:00:00`, {zone}).toMillis();
function series(frequency: RecurrenceFrequency, date: string): Doc<"bookings"> {
  const startAt=at(date),endAt=startAt+3600000;
  return { _id:"test",_creationTime:0,room:"Shema Space",roomKey:"shema space",resolvedVenues:["Shema Space"],requesterName:"Test",requesterEmail:"test@example.com",eventName:"Meeting",purpose:"Meeting",ministry:"Youth",status:"approved",timezone:zone,startAt,endAt,recurrenceFrequency:frequency,recurrenceHasEndDate:false,occurrences:expandRecurrence({startAt,endAt,timezone:zone,frequency,count:4}) } as unknown as Doc<"bookings">;
}
function move(booking: Doc<"bookings">, date: string, sequence=1) {
  const startAt=at(date);
  return requestCandidate(booking,sequence,"following",{room:"Shema Space",eventName:"Moved meeting",purpose:"Meeting",ministry:"Youth",startAt,endAt:startAt+3600000});
}
describe("requester recurrence frequency",()=>{
  beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(at("2026-01-01"));vi.stubEnv("BOOKING_MINISTRIES_JSON",'["Youth"]');});
  afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
  it.each([
    ["daily","2028-01-03","2028-01-10",["2028-01-10","2028-01-11","2028-01-12"]],
    ["weekly_same_day","2028-01-03","2028-01-12",["2028-01-12","2028-01-19","2028-01-26"]],
    ["biweekly_same_day","2028-01-03","2028-01-19",["2028-01-19","2028-02-02","2028-02-16"]],
    ["monthly_same_date","2028-01-15","2028-02-29",["2028-02-29","2028-03-29","2028-04-29"]],
    ["monthly_same_day","2028-01-03","2028-02-09",["2028-02-09","2028-03-08","2028-04-12"]],
  ] as const)("keeps %s and earlier meetings",(frequency,original,date,expected)=>{
    const booking=series(frequency,original);const result=move(booking,date);
    expect(result.recurrenceFrequency).toBe(frequency);
    expect(result.occurrences![0]).toEqual(booking.occurrences![0]);
    expect(result.occurrences!.slice(1).map(row=>DateTime.fromMillis(row.startAt,{zone}).toISODate())).toEqual(expected);
    expect(result.occurrences!.map(row=>row.sequence)).toEqual([0,1,2,3]);
  });
  it("skips missing month dates without recreating deleted identities",()=>{
    const booking=series("monthly_same_date","2028-01-15");booking.occurrences=booking.occurrences!.filter(row=>row.sequence!==2);
    const result=move(booking,"2028-03-31");
    expect(result.occurrences!.map(row=>row.sequence)).toEqual([0,1,3]);
    expect(DateTime.fromMillis(result.occurrences![2].startAt,{zone}).toISODate()).toBe("2028-05-31");
  });
  it("keeps recurrence unchanged for a single occurrence edit",()=>{
    const booking=series("monthly_same_date","2028-01-15");const startAt=at("2028-02-20");
    const result=requestCandidate(booking,1,"occurrence",{room:"Shema Space",eventName:"Moved",purpose:"Meeting",ministry:"Youth",startAt,endAt:startAt+3600000});
    expect(result.occurrences![2]).toEqual(booking.occurrences![2]);
    expect(result.recurrenceFrequency).toBe("monthly_same_date");
  });
});
