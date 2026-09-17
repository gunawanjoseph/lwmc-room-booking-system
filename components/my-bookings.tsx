"use client";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { useConvexAuth, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { bookingWindow, filterMeetings, sortMeetings, type BookingFilter } from "@/convex/lib/submitterBookings";
import { formatDateTime } from "@/lib/ui";
import { Brand } from "@/components/brand";

function BookingResults({email,timezone}:{email:string;timezone:string}) {
  const bookings=usePaginatedQuery(api.myBookings.list,{email},{initialNumItems:20});
  const [filter,setFilter]=useState<BookingFilter>("outstanding");
  const [sort,setSort]=useState<"booking"|"submitted">("booking");
  const [direction,setDirection]=useState<"asc"|"desc">("asc");
  const [visible,setVisible]=useState(50);
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60_000);return()=>clearInterval(timer);},[]);
  // Load all pages before sorting/filtering so order never means "this page only".
  useEffect(()=>{if(bookings.status==="CanLoadMore")bookings.loadMore(20);},[bookings.status,bookings.loadMore]);
  const rows=useMemo(()=>sortMeetings(filterMeetings(bookings.results.flatMap(row=>row.meetings),filter,now,timezone),sort,direction),[bookings.results,filter,now,timezone,sort,direction]);
  const window=bookingWindow(now,timezone);
  return <section className="panel my-bookings-panel">
    <div className="my-bookings-tabs" aria-label="Booking views">{([['outstanding','Outstanding'],['pending','Pending'],['all','All bookings'],['past','Past bookings']] as const).map(([value,label])=><button key={value} className="button button-secondary" aria-pressed={filter===value} onClick={()=>{setFilter(value);setVisible(50);}}>{label}</button>)}</div>
    <p>Outstanding: pending and approved meetings from {window.today} through {window.until} ({timezone}). Recurring meetings are listed individually.</p>
    <div className="my-bookings-controls"><label className="field"><span>Sort by</span><select value={sort} onChange={event=>setSort(event.target.value as typeof sort)}><option value="booking">Booking date</option><option value="submitted">Submission date</option></select></label><label className="field"><span>Order</span><select value={direction} onChange={event=>setDirection(event.target.value as typeof direction)}><option value="asc">Oldest first</option><option value="desc">Newest first</option></select></label></div>
    {bookings.status!=="Exhausted"?<p role="status">Loading your bookings…</p>:<><p role="status">{rows.length} meeting{rows.length===1?'':'s'} found.</p><div className="my-bookings-table"><table><thead><tr><th>Booking</th><th>Room</th><th>Meeting time</th><th>Submitted</th><th>Status</th></tr></thead><tbody>{rows.slice(0,visible).map(row=><tr key={row.key}><td><strong>{row.title}</strong><br/><small>Reference {row.reference}</small></td><td>{row.room}</td><td>{formatDateTime(row.startAt,row.timezone)}<br/><small>Ends {formatDateTime(row.endAt,row.timezone)}</small></td><td>{formatDateTime(row.submittedAt,timezone)}{row.submissionDateEstimated&&<small><br/>RoomOps received date</small>}</td><td>{row.status}{row.calendarSyncStatus==='creating'&&<small> · Calendar syncing</small>}{row.calendarSyncStatus==='failed'&&<small> · Calendar sync needs attention</small>}</td></tr>)}</tbody></table></div>{!rows.length&&<p>No bookings in this view.</p>}{visible<rows.length&&<button className="button button-secondary" onClick={()=>setVisible(value=>value+50)}>Show more meetings</button>}</>}
  </section>;
}
export function MyBookings() {
  const {isAuthenticated}=useConvexAuth();
  const viewer=useQuery(api.myBookings.viewer,isAuthenticated?{}:"skip");
  const [email,setEmail]=useState<string|null>(null);
  const [requested,setRequested]=useState("");
  const [error,setError]=useState("");
  return <main className="page my-bookings-page"><header className="my-bookings-header"><Link href="/"><Brand/></Link><UserButton/></header><h1>My bookings</h1><p>Check bookings using the same email you entered on the booking form. No administrator approval is needed to view your own bookings.</p>
    {!viewer?<p role="status">Checking your verified email…</p>:!viewer.email?<p role="alert">Verify your email in your account, then sign out and sign in again. Booking details are only available to the verified email owner.</p>:<><form className="my-bookings-lookup" onSubmit={event=>{event.preventDefault();const value=(email??viewer.email!).trim().toLowerCase();if(value!==viewer.email){setError('Sign out and sign in with this email to view its bookings.');return;}setError('');setRequested(value);}}><label className="field"><span>Booking email</span><input type="email" required value={email??viewer.email} onChange={event=>setEmail(event.target.value)} autoComplete="email"/></label><button className="button button-primary">Check my bookings</button></form><small>Signed in with verified email: {viewer.email}</small>{error&&<p className="form-error" role="alert">{error}</p>}{requested===viewer.email&&<BookingResults key={requested} email={requested} timezone={viewer.timezone}/>}</>}
  </main>;
}
