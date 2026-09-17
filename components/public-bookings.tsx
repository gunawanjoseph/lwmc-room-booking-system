"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { filterPublicMeetings } from "@/convex/lib/publicBookings";
import { BookingCalendar } from "@/components/booking-calendar";
import { Brand } from "@/components/brand";
import { formatDateTime } from "@/lib/ui";

function FilterGroup({label,options,selected,onChange}:{label:string;options:{value:string;label:string}[];selected:string[];onChange:(values:string[])=>void}) {
  return <fieldset className="public-booking-filter"><legend>{label}</legend>{options.map(option=><label key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={event=>onChange(event.target.checked?[...selected,option.value]:selected.filter(value=>value!==option.value))}/>{option.label}</label>)}</fieldset>;
}
export function PublicBookings() {
  const approved=usePaginatedQuery(api.myBookings.publicList,{},{initialNumItems:20});
  const settings=useQuery(api.myBookings.publicSettings,{});
  const [view,setView]=useState<"calendar"|"table">("calendar");
  const [ministries,setMinistries]=useState<string[]>([]);
  const [rooms,setRooms]=useState<string[]>([]);
  const [visible,setVisible]=useState(50);
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(approved.status==="CanLoadMore")approved.loadMore(20);},[approved.status,approved.loadMore]);
  const all=useMemo(()=>approved.results.flatMap(row=>row.meetings),[approved.results]);
  const ministryOptions=useMemo(()=>[...new Set([...all.map(row=>row.ministry),...ministries])].sort().map(value=>({value,label:value||"Unspecified"})),[all,ministries]);
  const roomOptions=useMemo(()=>[...new Set([...all.flatMap(row=>[row.room,...row.rooms]),...rooms])].sort().map(value=>({value,label:value})),[all,rooms]);
  const rows=useMemo(()=>filterPublicMeetings(all,{ministries,rooms}),[all,ministries,rooms]);
  const timezone=settings?.timezone??"Asia/Singapore";
  const ready=approved.status==="Exhausted"&&settings;
  function reset(){setMinistries([]);setRooms([]);setVisible(50);}
  return <main className="page my-bookings-page"><header className="my-bookings-header"><Link href="/"><Brand/></Link><Link className="button button-secondary" href="/sign-in">Administrator sign in</Link></header>
    <h1>Booking calendar</h1>
    <section className="panel my-bookings-panel">
      <div className="my-bookings-controls" aria-label="Display format">{(["calendar","table"] as const).map(value=><button className="button button-secondary" key={value} aria-pressed={view===value} onClick={()=>setView(value)}>{value==="calendar"?"Calendar view":"Table view"}</button>)}<button className="button button-secondary" onClick={reset}>Show all / reset filters</button></div>
      <p>{!ministries.length&&!rooms.length?"All Bookings":"Filtered Bookings"}</p>
      <div className="public-booking-filters"><FilterGroup label="Ministry" options={ministryOptions} selected={ministries} onChange={values=>{setMinistries(values);setVisible(50);}}/><FilterGroup label="Room" options={roomOptions} selected={rooms} onChange={values=>{setRooms(values);setVisible(50);}}/></div>
      <p className="public-filter-hint">Combine any filters. No ministry or room selected means all.</p>
      {!ready?<p role="status">Loading booking calendar…</p>:<><p role="status">{rows.length} matching meetings</p>{view==="calendar"?<BookingCalendar rows={rows} timezone={timezone} now={now}/>:<><div className="my-bookings-table"><table><thead><tr><th>Event</th><th>Ministry</th><th>Room</th><th>Meeting time</th><th>Status</th></tr></thead><tbody>{rows.slice(0,visible).map(row=><tr key={row.key}><td>{row.title}</td><td>{row.ministry||"Unspecified"}</td><td>{row.room}</td><td>{formatDateTime(row.startAt,timezone)}<br/>Ends {formatDateTime(row.endAt,timezone)}</td><td>{row.status}</td></tr>)}</tbody></table></div>{!rows.length&&<p>No bookings match these filters.</p>}{rows.length>visible&&<button className="button button-secondary" onClick={()=>setVisible(value=>value+50)}>Show more meetings</button>}</>}</>}
    </section>
  </main>;
}
