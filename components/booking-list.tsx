"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { dateKey } from "@/convex/lib/submitterBookings";
import { bookingListGroups } from "@/convex/lib/bookingList";
import type { PublicMeeting } from "@/convex/lib/publicBookings";
import { EventDetails } from "@/components/booking-calendar";

export function BookingList({rows,timezone,now}:{rows:PublicMeeting[];timezone:string;now:number}) {
  const today=dateKey(now,timezone);
  const groups=useMemo(()=>bookingListGroups(rows,today,timezone),[rows,today,timezone]);
  const viewport=useRef<HTMLDivElement>(null);
  const anchor=useRef<HTMLDivElement>(null);
  const [eventKey,setEventKey]=useState<string|null>(null);
  function goToday(){
    if(viewport.current&&anchor.current)viewport.current.scrollTop+=anchor.current.getBoundingClientRect().top-viewport.current.getBoundingClientRect().top;
  }
  // Opening List or changing filters mounts at today. Live updates don't reset browsing.
  useLayoutEffect(()=>{goToday();},[today,timezone]);
  function time(timestamp:number,showDate:boolean){return new Intl.DateTimeFormat('en-SG',{hour:'numeric',minute:'2-digit',timeZone:timezone,...(showDate?{day:'numeric' as const,month:'short' as const,year:'numeric' as const}:{})}).format(timestamp);}
  function section(group:typeof groups[number]) {
    return <section className="booking-list-day" key={group.day} aria-label={group.day}>
      <h3>{group.day===today?'Today · ':''}{new Intl.DateTimeFormat('en-SG',{weekday:'long',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${group.day}T12:00:00Z`))}</h3>
      {!group.meetings.length&&<p className="booking-list-empty">No bookings today match these filters.</p>}
      {group.meetings.map(row=>{
        const multiDay=dateKey(row.startAt,timezone)!==dateKey(row.endAt,timezone);
        return <button type="button" className="booking-list-event" key={row.key} aria-haspopup="dialog" onClick={()=>setEventKey(row.key)}>
          <span className="booking-list-copy"><strong>{row.title}</strong><span>{row.room}</span><small>{row.ministry||'Unspecified ministry'}{dateKey(row.startAt,timezone)<group.day?' · Continuing from an earlier day':''}</small></span>
          <span className="booking-list-times"><time dateTime={new Date(row.startAt).toISOString()} aria-label={`Starts ${time(row.startAt,true)}`}>{time(row.startAt,multiDay)}</time><time dateTime={new Date(row.endAt).toISOString()} aria-label={`Ends ${time(row.endAt,true)}`}>{time(row.endAt,multiDay)}</time></span>
        </button>;
      })}
    </section>;
  }
  return <div className="booking-list">
    <div className="booking-list-toolbar"><p>Scroll up for past events. Times in {timezone}.</p><button className="button button-secondary" onClick={goToday}>Today</button></div>
    <div ref={viewport} className="booking-list-scroll" tabIndex={0} aria-label="Booking list; scroll up for past events and down for upcoming events">
      {groups.filter(group=>group.day<today).map(section)}
      <div ref={anchor} className="booking-list-upcoming">{groups.filter(group=>group.day>=today).map(section)}{!rows.some(row=>dateKey(row.startAt,timezone)>today)&&<p className="booking-list-empty">No later bookings match these filters.</p>}</div>
    </div>
    {eventKey!==null&&<EventDetails meeting={rows.find(row=>row.key===eventKey)} timezone={timezone} onClose={()=>setEventKey(null)}/>}
  </div>;
}
