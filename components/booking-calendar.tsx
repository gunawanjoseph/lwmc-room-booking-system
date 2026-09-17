"use client";
import { useState } from "react";
import { dateKey, type SubmitterMeeting } from "@/convex/lib/submitterBookings";
import { meetingsOnDay, monthDays, shiftMonth } from "@/convex/lib/bookingCalendar";
import type { PublicMeeting } from "@/convex/lib/publicBookings";
import { formatDateTime } from "@/lib/ui";

export function BookingCalendar({rows,timezone,now}:{rows:(SubmitterMeeting|PublicMeeting)[];timezone:string;now:number}) {
  const today=dateKey(now,timezone);
  const [month,setMonth]=useState(()=>today.slice(0,7));
  const [selected,setSelected]=useState(today);
  const [expanded,setExpanded]=useState<string|null>(null);
  const days=monthDays(month);
  const title=new Intl.DateTimeFormat("en-SG",{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(`${month}-01T12:00:00Z`));
  const selectedRows=meetingsOnDay(rows,selected,timezone);
  function navigate(offset:number){const next=shiftMonth(month,offset);setMonth(next);setSelected(`${next}-01`);setExpanded(null);}
  function choose(day:string){setSelected(day);setExpanded(null);}
  return <div className="booking-calendar">
    <div className="booking-calendar-toolbar">
      <button className="button button-secondary" onClick={()=>{setMonth(today.slice(0,7));choose(today);}}>Today</button>
      <button className="button button-secondary" aria-label="Previous month" onClick={()=>navigate(-1)}>‹</button>
      <h2 aria-live="polite">{title}</h2>
      <button className="button button-secondary" aria-label="Next month" onClick={()=>navigate(1)}>›</button>
      <label className="field"><span>Jump to month</span><input type="month" value={month} onChange={event=>{if(/^\d{4}-\d{2}$/.test(event.target.value)){setMonth(event.target.value);choose(`${event.target.value}-01`);}}}/></label>
    </div>
    <p className="booking-calendar-zone">Times shown in {timezone}. Select a day to see its meetings. Filters above apply to both views.</p>
    <div className="booking-calendar-scroll"><div className="booking-calendar-grid" aria-label={title}>
      {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day=><div className="booking-calendar-weekday" key={day}>{day}</div>)}
      {days.map(day=>{const meetings=meetingsOnDay(rows,day,timezone);return <button type="button" key={day} className={`booking-calendar-day${day.slice(0,7)!==month?' outside':''}`} aria-pressed={selected===day} aria-current={day===today?'date':undefined} aria-label={`${day}, ${meetings.length} meetings`} onClick={()=>choose(day)}>
        <span className="booking-calendar-number">{Number(day.slice(-2))}</span>
        {meetings.slice(0,3).map(row=><span className={`booking-calendar-event status-${row.status}`} key={row.key}><span>{dateKey(row.startAt,timezone)<day?'Continues':new Intl.DateTimeFormat('en-SG',{hour:'numeric',minute:'2-digit',timeZone:timezone}).format(row.startAt)}</span> {row.title}</span>)}
        {meetings.length>3&&<span className="booking-calendar-more">+{meetings.length-3} more</span>}
      </button>;})}
    </div></div>
    <section className="booking-calendar-agenda" aria-label="Selected day meetings">
      <h3>{selected} · {selectedRows.length} meeting{selectedRows.length===1?'':'s'}</h3>
      {!selectedRows.length&&<p>No bookings on this day in the selected filter.</p>}
      {selectedRows.map(row=><article className="booking-calendar-detail" key={row.key}>
        <button type="button" aria-expanded={expanded===row.key} className="booking-calendar-detail-toggle" onClick={()=>setExpanded(expanded===row.key?null:row.key)}><strong>{row.title}</strong><span>{row.room} · {row.status}</span><span>{formatDateTime(row.startAt,timezone)} – {formatDateTime(row.endAt,timezone)}</span></button>
        {expanded===row.key&&<div className="booking-calendar-detail-body">{'ministry' in row&&<p>Ministry: {row.ministry||"Unspecified"}</p>}{'reference' in row&&<p>Reference {row.reference}</p>}{'submittedAt' in row&&<p>Submitted: {formatDateTime(row.submittedAt,timezone)}{row.submissionDateEstimated?' (RoomOps received date)':''}</p>}{'calendarSyncStatus' in row&&row.calendarSyncStatus==='creating'&&<p>Google Calendar synchronization is pending.</p>}{'calendarSyncStatus' in row&&row.calendarSyncStatus==='failed'&&<p>Google Calendar synchronization needs administrator attention.</p>}</div>}
      </article>)}
    </section>
  </div>;
}
