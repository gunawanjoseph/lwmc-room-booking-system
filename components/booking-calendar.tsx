"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { dateKey, type SubmitterMeeting } from "@/convex/lib/submitterBookings";
import { calendarTimeRange, meetingsOnDay, monthDays, shiftMonth, shiftDay, weekDays, timelineMeetings } from "@/convex/lib/bookingCalendar";
import type { PublicMeeting } from "@/convex/lib/publicBookings";
import { BookingLoading } from "@/components/booking-loading";
import { formatDateTime } from "@/lib/ui";
import { useSwipePaging } from "@/components/use-swipe-paging";
import { exitOverlay, fromKeyboard } from "@/lib/motion";

type CalendarMeeting = SubmitterMeeting | PublicMeeting;

export function EventDetails({meeting,timezone,onClose}:{meeting:CalendarMeeting|undefined;timezone:string;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const titleId=useId();
  useEffect(()=>{
    const element=dialog.current;
    const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null;
    element?.showModal();
    return()=>{element?.close();if(trigger?.isConnected)trigger.focus();};
  },[]);
  return <dialog ref={dialog} className="booking-event-dialog" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="booking-event-dialog-header"><span>Event details</span><button type="button" className="button button-secondary" autoFocus onClick={event=>fromKeyboard(event)?onClose():exitOverlay(dialog.current,onClose)}>Close</button></div>
    <h2 id={titleId}>{meeting?.title??"Event no longer available"}</h2>
    {meeting?<dl className="booking-event-facts">
      <dt>Starts</dt><dd>{formatDateTime(meeting.startAt,timezone)}</dd>
      <dt>Ends</dt><dd>{formatDateTime(meeting.endAt,timezone)}</dd>
      <dt>Timezone</dt><dd>{timezone}</dd>
      <dt>Room</dt><dd>{meeting.room}</dd>
      {'ministry' in meeting&&<><dt>Ministry</dt><dd>{meeting.ministry||"Unspecified"}</dd></>}
      <dt>Status</dt><dd>{'source' in meeting&&meeting.source==='google'?`Google Calendar · ${meeting.googleStatus}`:meeting.status}</dd>
      {'allDay' in meeting&&meeting.allDay&&<><dt>Duration</dt><dd>All day (end date is exclusive)</dd></>}
      {'reference' in meeting&&<><dt>Reference</dt><dd>{meeting.reference}</dd></>}
      {'submittedAt' in meeting&&<><dt>Submitted</dt><dd>{formatDateTime(meeting.submittedAt,timezone)}{meeting.submissionDateEstimated?' (RoomOps received date)':''}</dd></>}
    </dl>:<p>This event was removed or no longer matches the current view.</p>}
    {meeting&&'calendarSyncStatus' in meeting&&meeting.calendarSyncStatus==='creating'&&<p>Google Calendar synchronization is pending.</p>}
    {meeting&&'calendarSyncStatus' in meeting&&meeting.calendarSyncStatus==='failed'&&<p>Google Calendar synchronization needs administrator attention.</p>}
  </dialog>;
}

function TimeGrid({rows,days,selected,timezone,onSelect,onOpen}:{rows:CalendarMeeting[];days:string[];selected:string;timezone:string;onSelect:(day:string)=>void;onOpen:(key:string)=>void}) {
  const viewport=useRef<HTMLDivElement>(null);
  const blocks=days.map(day=>({day,blocks:timelineMeetings(rows,day,timezone)}));
  useEffect(()=>{if(viewport.current)viewport.current.scrollTop=7*60;},[selected,days.length]);
  return <div className={`booking-time-view ${days.length===7?'is-week':'is-day'}`}>
    <div className="booking-time-dates">{days.map(day=><button type="button" key={day} aria-pressed={day===selected} onClick={()=>onSelect(day)}><span>{new Intl.DateTimeFormat('en-SG',{weekday:'short',timeZone:'UTC'}).format(new Date(`${day}T12:00:00Z`))}</span><strong>{Number(day.slice(-2))}</strong></button>)}</div>
    <div className="booking-time-scroll" ref={viewport} tabIndex={0} aria-label="Hourly schedule; scroll to see all hours">
      <div className="booking-time-grid" style={{gridTemplateColumns:`44px repeat(${days.length}, minmax(0,1fr))`}}>
        <div className="booking-time-hours">{Array.from({length:24},(_,hour)=><span key={hour} style={{top:hour*60}}>{String(hour).padStart(2,'0')}:00</span>)}</div>
        {blocks.map(({day,blocks})=><div key={day} className="booking-time-column" data-selected={day===selected} aria-label={day}>
          {blocks.map(({meeting,start,end,lane,lanes})=><button type="button" key={meeting.key} className="booking-time-event" aria-haspopup="dialog" aria-label={`${meeting.title}. ${formatDateTime(meeting.startAt,timezone)} to ${formatDateTime(meeting.endAt,timezone)}. View event details.`} style={{top:start,height:end-start,left:`${lane/lanes*100}%`,width:`${100/lanes}%`}} onClick={()=>{onSelect(day);onOpen(meeting.key);}}><strong>{meeting.title}</strong><span>{calendarTimeRange(meeting,timezone)}</span><span>{meeting.room}</span></button>)}
        </div>)}
      </div>
    </div>
  </div>;
}

export function BookingCalendar({rows,timezone,now,initialDate,onMonthChange}:{rows:CalendarMeeting[];timezone:string;now:number;initialDate?:string;onMonthChange?:(month:string)=>void}) {
  const [pending,startTransition]=useTransition();
  const today=dateKey(now,timezone);
  const [mode,setMode]=useState<"day"|"week"|"month">("month");
  const [selected,setSelected]=useState(initialDate??today);
  const [eventKey,setEventKey]=useState<string|null>(null);
  const [direction,setDirection]=useState<"next"|"prev">("next");
  const pager=useRef<HTMLDivElement>(null);
  const month=selected.slice(0,7);
  useEffect(()=>{onMonthChange?.(month);},[month,onMonthChange]);
  const days=monthDays(month);
  const week=weekDays(selected);
  const label=(day:string,options:Intl.DateTimeFormatOptions)=>new Intl.DateTimeFormat("en-SG",{...options,timeZone:"UTC"}).format(new Date(`${day}T12:00:00Z`));
  const title=mode==="month"?label(selected,{month:"long",year:"numeric"}):mode==="day"?label(selected,{day:"numeric",month:"long",year:"numeric"}):`${label(week[0],{day:"numeric",month:"short",year:"numeric"})} – ${label(week[6],{day:"numeric",month:"short",year:"numeric"})}`;
  const selectedRows=meetingsOnDay(rows,selected,timezone);
  function choose(day:string){if(day!==selected)setDirection(day>selected?"next":"prev");startTransition(()=>{setSelected(day);setEventKey(null);});}
  function chooseMonthDay(day:string){
    choose(day);
    if(window.matchMedia("(max-width: 700px)").matches)startTransition(()=>setMode("week"));
  }
  function navigate(offset:number){choose(mode==="month"?`${shiftMonth(month,offset)}-01`:shiftDay(selected,offset*(mode==="week"?7:1)));}
  useSwipePaging(pager,navigate);
  // New periods slide in from the side the swipe/arrow points to.
  const periodKey=mode==="month"?month:mode==="week"?week[0]:selected;
  return <div className="booking-calendar">
    <div className="booking-view-switch" aria-label="Calendar period">{(["day","week","month"] as const).map(value=><button type="button" key={value} aria-pressed={mode===value} onClick={()=>startTransition(()=>setMode(value))}>{value[0].toUpperCase()+value.slice(1)}</button>)}</div>
    <div className="booking-calendar-toolbar">
      <h2 aria-live="polite">{title}</h2>
      <div className="booking-calendar-navigation"><button className="button button-secondary" aria-label={`Previous ${mode}`} onClick={()=>navigate(-1)}>‹</button><button className="button button-secondary" onClick={()=>choose(today)}>Today</button><button className="button button-secondary" aria-label={`Next ${mode}`} onClick={()=>navigate(1)}>›</button></div>
      <label className="field"><span>Jump to date</span><input type="date" value={selected} onChange={event=>{if(/^\d{4}-\d{2}-\d{2}$/.test(event.target.value))choose(event.target.value);}}/></label>
    </div>
    <p className="booking-calendar-zone">Times shown in {timezone}. Tap a day to select it or an event for full details.</p>
    <BookingLoading busy={pending}>
    <div className="booking-calendar-pager" ref={pager}><div key={`${mode}-${periodKey}`} className="booking-calendar-period" data-direction={direction}>
    {mode==="month"?<div className="booking-calendar-scroll"><div className="booking-calendar-grid" aria-label={title}>
      {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day=><div className="booking-calendar-weekday" key={day}>{day}</div>)}
      {days.map(day=>{const meetings=meetingsOnDay(rows,day,timezone);return <div key={day} className={`booking-calendar-day${day.slice(0,7)!==month?' outside':''}`} data-selected={selected===day} data-today={day===today}>
        <button type="button" className="booking-day-target" aria-pressed={selected===day} aria-current={day===today?'date':undefined} aria-label={`${day}, ${meetings.length} meetings. Select day.`} onClick={()=>chooseMonthDay(day)}/>
        <span className="booking-calendar-number">{Number(day.slice(-2))}</span>
        <span className="booking-mobile-count" aria-hidden="true">{meetings.length?`${meetings.length} ●`:''}</span>
        {meetings.slice(0,3).map(row=><button type="button" className={`booking-calendar-event status-${row.status}`} key={row.key} aria-haspopup="dialog" aria-label={`${row.title}. ${formatDateTime(row.startAt,timezone)} to ${formatDateTime(row.endAt,timezone)}. View event details.`} onClick={()=>{setSelected(day);setEventKey(row.key);}}><span className="booking-calendar-event-time">{calendarTimeRange(row,timezone)}</span><span className="booking-calendar-event-title">{row.title}</span></button>)}
        {meetings.length>3&&<button type="button" className="booking-calendar-more" aria-label={`Show all ${meetings.length} meetings on ${day}`} onClick={()=>chooseMonthDay(day)}>+{meetings.length-3} more</button>}
      </div>;})}
    </div></div>:<><p className="booking-mobile-week-hint">{mode==="week"?'Select a day above the timeline to browse this week.':''}</p><TimeGrid rows={rows} days={mode==="week"?week:[selected]} selected={selected} timezone={timezone} onSelect={choose} onOpen={setEventKey}/></>}
    </div></div>
    <section className="booking-calendar-agenda" aria-label="Selected day meetings">
      <h3>{label(selected,{weekday:"long",day:"numeric",month:"short"})} · {selectedRows.length} meeting{selectedRows.length===1?'':'s'}</h3>
      {!selectedRows.length&&<p>No bookings on this day in the selected filter.</p>}
      {selectedRows.map(row=><article className="booking-calendar-detail" key={row.key}>
        <button type="button" aria-haspopup="dialog" className="booking-calendar-detail-toggle" onClick={()=>setEventKey(row.key)}><strong>{row.title}</strong><span>{row.room} · {'source' in row&&row.source==='google'?row.googleStatus:row.status}</span><span>{formatDateTime(row.startAt,timezone)} – {formatDateTime(row.endAt,timezone)}</span><span>View event details</span></button>
      </article>)}
    </section>
    </BookingLoading>
    {eventKey!==null&&<EventDetails meeting={rows.find(row=>row.key===eventKey)} timezone={timezone} onClose={()=>setEventKey(null)}/>}
  </div>;
}
