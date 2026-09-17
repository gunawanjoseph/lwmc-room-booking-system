"use client";
import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { filterPublicMeetings } from "@/convex/lib/publicBookings";
import { BookingCalendar } from "@/components/booking-calendar";
import { Brand } from "@/components/brand";
import { BookingLoading } from "@/components/booking-loading";
import { BookingList } from "@/components/booking-list";

function FilterGroup({label,options,selected,onChange}:{label:string;options:{value:string;label:string}[];selected:string[];onChange:(values:string[])=>void}) {
  return <fieldset className="public-booking-filter"><legend>{label}</legend>{options.map(option=><label key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={event=>onChange(event.target.checked?[...selected,option.value]:selected.filter(value=>value!==option.value))}/>{option.label}</label>)}</fieldset>;
}
export function PublicBookings() {
  const approved=usePaginatedQuery(api.myBookings.publicList,{},{initialNumItems:20});
  const settings=useQuery(api.myBookings.publicSettings,{});
  const [view,setView]=useState<"calendar"|"list">("calendar");
  const [ministries,setMinistries]=useState<string[]>([]);
  const [rooms,setRooms]=useState<string[]>([]);
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(approved.status==="CanLoadMore")approved.loadMore(20);},[approved.status,approved.loadMore]);
  const all=useMemo(()=>approved.results.flatMap(row=>row.meetings),[approved.results]);
  const ministryOptions=useMemo(()=>[...new Set([...all.map(row=>row.ministry),...ministries])].sort().map(value=>({value,label:value||"Unspecified"})),[all,ministries]);
  const roomOptions=useMemo(()=>[...new Set([...all.flatMap(row=>[row.room,...row.rooms]),...rooms])].sort().map(value=>({value,label:value})),[all,rooms]);
  const requested=useMemo(()=>({all,ministries,rooms,view}),[all,ministries,rooms,view]);
  const deferred=useDeferredValue(requested);
  const rows=useMemo(()=>filterPublicMeetings(deferred.all,{ministries:deferred.ministries,rooms:deferred.rooms}),[deferred]);
  const timezone=settings?.timezone??"Asia/Singapore";
  const ready=approved.status==="Exhausted"&&settings;
  function reset(){setMinistries([]);setRooms([]);}
  return <main className="page my-bookings-page"><header className="my-bookings-header"><Link href="/"><Brand/></Link><Link className="button button-secondary" href="/sign-in">Administrator sign in</Link></header>
    <h1>Booking calendar</h1>
    <section className="panel my-bookings-panel">
      <div className="booking-filter-heading"><p>{!ministries.length&&!rooms.length?"All Bookings":"Filtered Bookings"}</p><button className="button button-secondary" onClick={reset}>Reset filters</button></div>
      <div className="public-booking-filters"><FilterGroup label="Ministry" options={ministryOptions} selected={ministries} onChange={values=>{setMinistries(values);}}/><FilterGroup label="Room" options={roomOptions} selected={rooms} onChange={values=>{setRooms(values);}}/></div>
      <p className="public-filter-hint">Combine any filters. No ministry or room selected means all.</p>
      <div className="booking-display-switch" role="group" aria-label="Display format">{(["calendar","list"] as const).map(value=><button type="button" key={value} aria-pressed={view===value} onClick={()=>setView(value)}>{value==="calendar"?"Calendar":"List"}</button>)}</div>
      <BookingLoading busy={!ready||requested!==deferred}>
        {!ready?<div className="booking-initial-loading"/>:deferred.view==="calendar"?<BookingCalendar rows={rows} timezone={timezone} now={now}/>:<BookingList key={JSON.stringify([deferred.ministries,deferred.rooms])} rows={rows} timezone={timezone} now={now}/>}
      </BookingLoading>

    </section>
  </main>;
}
