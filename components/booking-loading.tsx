"use client";
import { useEffect, useState, type ReactNode } from "react";

/** Keep the current layout while work is pending; avoid flashing for fast updates. */
export function BookingLoading({busy,children}:{busy:boolean;children:ReactNode}) {
  const [show,setShow]=useState(false);
  useEffect(()=>{
    if(!busy){setShow(false);return;}
    const timer=setTimeout(()=>setShow(true),150);
    return()=>clearTimeout(timer);
  },[busy]);
  return <div className="booking-loading-region" aria-busy={busy}>
    <div inert={busy} className={busy&&show?'booking-loading-content is-loading':'booking-loading-content'}>{children}</div>
    {busy&&show&&<div className="booking-loading-overlay" role="status"><span className="booking-loading-spinner" aria-hidden="true"/><span>Loading bookings…</span></div>}
  </div>;
}
