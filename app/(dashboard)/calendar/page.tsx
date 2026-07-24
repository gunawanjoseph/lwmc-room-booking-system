"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { CalendarDays, ExternalLink } from "lucide-react";
import { api } from "@/convex/_generated/api";

type CalendarVenue = {
  venue: string;
  calendarIds: string[];
};

type CalendarEmbedConfig = {
  configured: boolean;
  timeZone: string;
  venues: CalendarVenue[];
};

function calendarEmbedUrl(
  calendarIds: readonly string[],
  timeZone: string,
) {
  const params = new URLSearchParams({
    ctz: timeZone,
    mode: "WEEK",
    showCalendars: "0",
    showDate: "1",
    showNav: "1",
    showPrint: "0",
    showTabs: "1",
    showTitle: "0",
  });
  for (const calendarId of calendarIds) {
    params.append("src", calendarId);
  }
  return `https://calendar.google.com/calendar/embed?${params.toString()}`;
}

function googleCalendarUrl(calendarId: string) {
  const params = new URLSearchParams({ cid: calendarId });
  return `https://calendar.google.com/calendar/u/0/r?${params.toString()}`;
}

export default function CalendarTimelinePage() {
  const config = useQuery(
    api.bookings.listCalendarEmbeds,
  ) as CalendarEmbedConfig | undefined;
  const [selectedVenue, setSelectedVenue] = useState<string | null>(
    null,
  );

  const venues = useMemo(() => config?.venues ?? [], [config]);
  const activeVenue = useMemo(() => {
    if (venues.length === 0) return null;
    return (
      venues.find((venue) => venue.venue === selectedVenue) ??
      venues[0]
    );
  }, [selectedVenue, venues]);

  const embedUrl =
    activeVenue && config
      ? calendarEmbedUrl(activeVenue.calendarIds, config.timeZone)
      : "";

  return (
    <div className="page calendar-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">VENUE TIMELINE</span>
          <h1>Calendar</h1>
          <p>
            View read-only Google Calendar timelines for each bookable
            venue. Calendar edits still happen through booking approval
            and Google Calendar itself.
          </p>
        </div>
      </header>

      {config === undefined ? (
        <section className="panel calendar-empty-state">
          <span className="loading-ring" />
          <p>Loading calendar configuration…</p>
        </section>
      ) : !config.configured || venues.length === 0 ? (
        <section className="panel calendar-empty-state">
          <CalendarDays size={24} />
          <h2>Google Calendar map is not configured</h2>
          <p>
            Set `GOOGLE_CALENDAR_VENUE_MAP_JSON` in Convex to show
            venue timelines here.
          </p>
        </section>
      ) : (
        <>
          <section className="calendar-venue-grid" aria-label="Venues">
            {venues.map((venue) => {
              const selected = activeVenue?.venue === venue.venue;
              return (
                <button
                  key={venue.venue}
                  type="button"
                  aria-pressed={selected}
                  className={
                    selected
                      ? "calendar-venue-card calendar-venue-card-active"
                      : "calendar-venue-card"
                  }
                  onClick={() => setSelectedVenue(venue.venue)}
                >
                  <strong>{venue.venue}</strong>
                  <span>
                    {venue.calendarIds.length} calendar
                    {venue.calendarIds.length === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </section>

          {activeVenue && (
            <section className="panel calendar-panel">
              <div className="calendar-panel-header">
                <div>
                  <span className="panel-kicker">READ ONLY</span>
                  <h2>{activeVenue.venue}</h2>
                </div>
                <div className="calendar-link-actions">
                  {activeVenue.calendarIds.map((calendarId, index) => (
                    <a
                      key={calendarId}
                      className="button button-secondary button-small"
                      href={googleCalendarUrl(calendarId)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={15} />
                      Open calendar
                      {activeVenue.calendarIds.length > 1
                        ? ` ${index + 1}`
                        : ""}
                    </a>
                  ))}
                </div>
              </div>
              <iframe
                className="calendar-embed"
                src={embedUrl}
                title={`${activeVenue.venue} Google Calendar`}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
