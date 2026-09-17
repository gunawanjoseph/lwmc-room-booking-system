"use client";
import { useEffect, useId, useRef, useState } from "react";
import { dateKey, type SubmitterMeeting } from "@/convex/lib/submitterBookings";
import { calendarTimeRange, meetingsOnDay, monthDays, shiftMonth } from "@/convex/lib/bookingCalendar";
import type { PublicMeeting } from "@/convex/lib/publicBookings";
import { formatDateTime } from "@/lib/ui";

type CalendarMeeting = SubmitterMeeting | PublicMeeting;

function EventDetails({meeting,timezone,onClose}:{meeting:CalendarMeeting|undefined;timezone:string;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const titleId=useId();
  useEffect(()=>{
    const element=dialog.current;
    const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null;
    element?.showModal();
    return()=>{element?.close();if(trigger?.isConnected)trigger.focus();};
  },[]);
  return <dialog ref={dialog} className="booking-event-dialog" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="booking-event-dialog-header"><span>Event details</span><button type="button" className="button button-secondary" autoFocus onClick={onClose}>Close</button></div>
    <h2 id={titleId}>{meeting?.title??"Event no longer available"}</h2>
    {meeting?<dl className="booking-event-facts">
      <dt>Starts</dt><dd>{formatDateTime(meeting.startAt,timezone)}</dd>
      <dt>Ends</dt><dd>{formatDateTime(meeting.endAt,timezone)}</dd>
      <dt>Timezone</dt><dd>{timezone}</dd>
      <dt>Room</dt><dd>{meeting.room}</dd>
      {'ministry' in meeting&&<><dt>Ministry</dt><dd>{meeting.ministry||"Unspecified"}</dd></>}
      <dt>Status</dt><dd>{meeting.status}</dd>
      {'reference' in meeting&&<><dt>Reference</dt><dd>{meeting.reference}</dd></>}
      {'submittedAt' in meeting&&<><dt>Submitted</dt><dd>{formatDateTime(meeting.submittedAt,timezone)}{meeting.submissionDateEstimated?' (RoomOps received date)':''}</dd></>}
    </dl>:<p>This event was removed or no longer matches the current view.</p>}
    {meeting&&'calendarSyncStatus' in meeting&&meeting.calendarSyncStatus==='creating'&&<p>Google Calendar synchronization is pending.</p>}
    {meeting&&'calendarSyncStatus' in meeting&&meeting.calendarSyncStatus==='failed'&&<p>Google Calendar synchronization needs administrator attention.</p>}
  </dialog>;
}

export function BookingCalendar({rows,timezone,now}:{rows:(SubmitterMeeting|PublicMeeting)[];timezone:string;now:number}) {
  const today=dateKey(now,timezone);
  const [month,setMonth]=useState(()=>today.slice(0,7));
  const [selected,setSelected]=useState(today);
  const [eventKey,setEventKey]=useState<string|null>(null);
  const days=monthDays(month);
  const title=new Intl.DateTimeFormat("en-SG",{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(`${month}-01T12:00:00Z`));
  const selectedRows=meetingsOnDay(rows,selected,timezone);
  function navigate(offset:number){const next=shiftMonth(month,offset);setMonth(next);setSelected(`${next}-01`);setEventKey(null);}
  function choose(day:string){setSelected(day);setEventKey(null);}
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
      {days.map(day=>{const meetings=meetingsOnDay(rows,day,timezone);return <div key={day} className={`booking-calendar-day${day.slice(0,7)!==month?' outside':''}`} data-selected={selected===day} data-today={day===today}>
        <button type="button" className="booking-calendar-number" aria-pressed={selected===day} aria-current={day===today?'date':undefined} aria-label={`${day}, ${meetings.length} meetings`} onClick={()=>choose(day)}>{Number(day.slice(-2))}</button>
        {meetings.slice(0,3).map(row=><button type="button" className={`booking-calendar-event status-${row.status}`} key={row.key} aria-haspopup="dialog" aria-label={`${row.title}. ${formatDateTime(row.startAt,timezone)} to ${formatDateTime(row.endAt,timezone)}. View event details.`} onClick={()=>{setSelected(day);setEventKey(row.key);}}><span className="booking-calendar-event-time">{calendarTimeRange(row,timezone)}</span><span className="booking-calendar-event-title">{row.title}</span></button>)}
        {meetings.length>3&&<button type="button" className="booking-calendar-more" aria-label={`Show all ${meetings.length} meetings on ${day}`} onClick={()=>choose(day)}>+{meetings.length-3} more</button>}
      </div>;})}
    </div></div>
    <section className="booking-calendar-agenda" aria-label="Selected day meetings">
      <h3>{selected} · {selectedRows.length} meeting{selectedRows.length===1?'':'s'}</h3>
      {!selectedRows.length&&<p>No bookings on this day in the selected filter.</p>}
      {selectedRows.map(row=><article className="booking-calendar-detail" key={row.key}>
        <button type="button" aria-haspopup="dialog" className="booking-calendar-detail-toggle" onClick={()=>setEventKey(row.key)}><strong>{row.title}</strong><span>{row.room} · {row.status}</span><span>{formatDateTime(row.startAt,timezone)} – {formatDateTime(row.endAt,timezone)}</span><span>View event details</span></button>
      </article>)}
    </section>
    {eventKey!==null&&<EventDetails meeting={rows.find(row=>row.key===eventKey)} timezone={timezone} onClose={()=>setEventKey(null)}/>}
  </div>;
}
