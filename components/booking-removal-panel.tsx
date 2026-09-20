"use client";
import { useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { CalendarDays, CircleSlash2, Trash2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatDateTime, messageFromError } from "@/lib/ui";
import type { RecurrenceScope } from "@/convex/lib/recurrenceScope";

type RemovalBooking = {
  _id: Id<"bookings">; status?: string; cancellationPending?: boolean; revision?: number; room: string; timezone: string;
  startAt: number; endAt: number; eventName?: string; jotformSubmissionId: string;
  occurrences?: Array<{sequence: number; startAt: number; endAt: number; room?: string}>;
};
export function BookingRemovalPanel({ booking, close }: {booking: RemovalBooking; close: (notice?: string) => void}) {
  const erase = useMutation(api.bookings.eraseCancelled);
  const cancelled = booking.status === "cancelled";
  const removeAll = useAction(api.googleCalendar.deleteBooking);
  const removeSome = useMutation(api.bookings.removeOccurrences);
  const occurrences = booking.occurrences ?? [{sequence:0,startAt:booking.startAt,endAt:booking.endAt}];
  const recurring = occurrences.length > 1;
  const [scope, setScope] = useState<RecurrenceScope>(recurring ? "occurrence" : "series");
  const [sequence, setSequence] = useState(() => occurrences.find(item => item.endAt > Date.now())?.sequence ?? occurrences[0].sequence);
  const [reason, setReason] = useState("");
  const [notifySubmitter, setNotifySubmitter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLElement>(null);
  const selected = occurrences.find(item => item.sequence === sequence)!;
  const count = scope === "series" ? occurrences.length : scope === "occurrence" ? 1 : occurrences.filter(item => item.startAt >= selected.startAt).length;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  async function submit() {
    if (busy || booking.cancellationPending) return;
    setBusy(true); setError("");
    try {
      if (cancelled) {
        await erase({bookingId:booking._id,expectedRevision:booking.revision ?? 0});
        close("Cancelled booking data erased.");
        return;
      }
      if (scope !== "series") {
        const result = await removeSome({bookingId:booking._id,expectedRevision:booking.revision ?? 0,scope,occurrenceSequence:sequence,notifySubmitter,reason});
        if (!result.deleteAllRequired) {
          close(result.calendarQueued ? `${count} meeting(s) cancelled. Google Calendar is updating; the cancelled record will remain.` : `${count} meeting(s) cancelled; the other meetings were kept.`);
          return;
        }
      }
      await removeAll({bookingId:booking._id,expectedRevision:booking.revision ?? 0,notifySubmitter,reason});
      close("Booking cancelled and removed from Google Calendar. Its record is kept for reference.");
    } catch (caught) { setError(messageFromError(caught)); setBusy(false); }
  }
  return <div className="drawer-backdrop">
    <aside ref={panel} tabIndex={-1} className="booking-drawer" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="remove-booking-title"
      onKeyDown={event => {
        if (event.key === "Escape" && !busy) close();
        if (event.key === "Tab") {
          const items = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]');
          if (!items?.length) {event.preventDefault();return;}
          const first=items[0],last=items[items.length-1];
          if(event.shiftKey && (document.activeElement===first || document.activeElement===panel.current)){event.preventDefault();last.focus();}
          else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
        }
      }}>
      <div className="modal-heading"><span className="panel-kicker">MANAGE MEETINGS</span><button type="button" className="icon-button" disabled={busy} onClick={()=>close()} aria-label="Close cancellation panel"><X size={20}/></button></div>
      <h2 id="remove-booking-title">{cancelled ? "Erase booking data?" : "Cancel booking"}</h2>
      <div className="removal-summary"><CalendarDays size={24}/><div><strong>{booking.eventName || booking.room}</strong><p>{booking.room} · {occurrences.length} meeting{recurring ? "s" : ""}</p><small>Booking {booking.jotformSubmissionId}</small></div></div>
      {!cancelled && recurring && <>
        <label className="field"><span>Selected meeting</span><select disabled={busy} value={sequence} onChange={event=>setSequence(Number(event.target.value))}>{occurrences.map(item=><option key={item.sequence} value={item.sequence}>{formatDateTime(item.startAt,booking.timezone)} · {item.room ?? booking.room}</option>)}</select></label>
        <fieldset className="scope-options" disabled={busy}><legend>Which meetings should be cancelled?</legend>{([
          ["occurrence","This event","Keep every other meeting."],
          ["following","This and following events","Cancel the selected date and every later date."],
          ["series","All events","Cancel the entire booking, including past dates."],
        ] as const).map(([value,title,description])=><label className={`scope-option ${scope===value?"selected":""}`} key={value}><input type="radio" name="remove-scope" checked={scope===value} onChange={()=>setScope(value)}/><span><strong>{title}</strong><small>{description}</small></span></label>)}</fieldset>
      </>}
      {cancelled ? <div className="removal-impact"><p>This permanently erases the cancelled booking record. It cannot be undone.</p>{booking.cancellationPending && <p role="status">Google Calendar cleanup must finish before you can erase this record.</p>}</div> : <>
        <div className="removal-impact"><strong>{count} meeting{count===1?"":"s"} will be cancelled</strong><p>The cancelled record will remain read-only. Google Calendar must finish updating before you rely on the room schedule.</p></div>
        <label className="field"><span>Reason (optional)</span><textarea rows={3} maxLength={2000} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
        <label className="notification-choice"><input type="checkbox" checked={notifySubmitter} disabled={busy} onChange={event=>setNotifySubmitter(event.target.checked)}/><span>Email the requester after cancellation</span></label>
      </>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="drawer-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={()=>close()}>{cancelled ? "Keep record" : "Go back"}</button><button type="button" className="button button-danger" disabled={busy || booking.cancellationPending} onClick={submit}>{cancelled ? <Trash2 size={16}/> : <CircleSlash2 size={16}/>} {busy ? "Saving…" : cancelled ? "Erase data" : "Cancel booking"}</button></div>
    </aside>
  </div>;
}
