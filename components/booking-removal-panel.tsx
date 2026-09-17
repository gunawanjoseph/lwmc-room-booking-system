"use client";
import { useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { CalendarDays, Trash2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatDateTime, messageFromError } from "@/lib/ui";
import type { RecurrenceScope } from "@/convex/lib/recurrenceScope";

type RemovalBooking = {
  _id: Id<"bookings">; revision?: number; room: string; timezone: string;
  startAt: number; endAt: number; eventName?: string; jotformSubmissionId: string;
  occurrences?: Array<{sequence: number; startAt: number; endAt: number; room?: string}>;
};
export function BookingRemovalPanel({ booking, close }: {booking: RemovalBooking; close: (notice?: string) => void}) {
  const removeAll = useAction(api.googleCalendar.deleteBooking);
  const removeSome = useMutation(api.bookings.removeOccurrences);
  const occurrences = booking.occurrences ?? [{sequence:0,startAt:booking.startAt,endAt:booking.endAt}];
  const recurring = occurrences.length > 1;
  const [scope, setScope] = useState<RecurrenceScope>(recurring ? "occurrence" : "series");
  const [sequence, setSequence] = useState(() => occurrences.find(item => item.endAt > Date.now())?.sequence ?? occurrences[0].sequence);
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
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (scope !== "series") {
        const result = await removeSome({bookingId:booking._id,expectedRevision:booking.revision ?? 0,scope,occurrenceSequence:sequence});
        if (!result.deleteAllRequired) {
          close(result.calendarQueued ? `${count} meeting(s) selected for removal. Calendar synchronization is in progress; check its status before relying on room controls.` : `${count} meeting(s) removed; the other meetings were kept.`);
          return;
        }
      }
      await removeAll({bookingId:booking._id,expectedRevision:booking.revision ?? 0});
      close("Booking removed after Calendar cleanup. Check room controls if a meeting was due to start or already running.");
    } catch (caught) { setError(messageFromError(caught)); setBusy(false); }
  }
  return <div className="drawer-backdrop">
    <aside ref={panel} tabIndex={-1} className="booking-drawer" role="dialog" aria-modal="true" aria-labelledby="remove-booking-title"
      onKeyDown={event => {
        if (event.key === "Escape" && !busy) close();
        if (event.key === "Tab") {
          const items = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]');
          if (!items?.length) {event.preventDefault();return;}
          const first=items[0],last=items[items.length-1];
          if(event.shiftKey && (document.activeElement===first || document.activeElement===panel.current)){event.preventDefault();last.focus();}
          else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
        }
      }}>
      <div className="modal-heading"><span className="panel-kicker">MANAGE MEETINGS</span><button type="button" className="icon-button" disabled={busy} onClick={()=>close()} aria-label="Close removal panel"><X size={20}/></button></div>
      <h2 id="remove-booking-title">Remove {recurring ? "meetings" : "meeting"}</h2>
      <div className="removal-summary"><CalendarDays size={24}/><div><strong>{booking.eventName || booking.room}</strong><p>{booking.room} · {occurrences.length} meeting{recurring ? "s" : ""}</p><small>Booking {booking.jotformSubmissionId}</small></div></div>
      {recurring && <>
        <label className="field"><span>Selected meeting</span><select disabled={busy} value={sequence} onChange={event=>setSequence(Number(event.target.value))}>{occurrences.map(item=><option key={item.sequence} value={item.sequence}>{formatDateTime(item.startAt,booking.timezone)} · {item.room ?? booking.room}</option>)}</select></label>
        <fieldset className="scope-options" disabled={busy}><legend>Which meetings should be removed?</legend>{([
          ["occurrence","This event","Keep every other meeting."],
          ["following","This and following events","Remove the selected date and every later date."],
          ["series","All events","Remove the entire booking, including past dates."],
        ] as const).map(([value,title,description])=><label className={`scope-option ${scope===value?"selected":""}`} key={value}><input type="radio" name="remove-scope" checked={scope===value} onChange={()=>setScope(value)}/><span><strong>{title}</strong><small>{description}</small></span></label>)}</fieldset>
      </>}
      <div className="removal-impact"><strong>{count} meeting{count===1?"":"s"} will be removed</strong><p>{occurrences.length-count} will remain. This cannot be undone automatically. Calendar changes must finish before you rely on the room schedule.</p></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="drawer-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={()=>close()}>Keep booking</button><button type="button" className="button button-danger" disabled={busy} onClick={submit}><Trash2 size={16}/>{busy ? "Removing…" : `Remove ${count===1?"meeting":"meetings"}`}</button></div>
    </aside>
  </div>;
}
