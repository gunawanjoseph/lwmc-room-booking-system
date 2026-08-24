import Link from "next/link";
import {
  ArrowRight,
  CalendarCheck2,
  FileInput,
  ShieldCheck,
  TableProperties,
} from "lucide-react";
import { Brand } from "@/components/brand";
import { JOTFORM_FORM_ID, JOTFORM_FORM_URL } from "@/shared/jotformConstants";

const features = [
  {
    icon: FileInput,
    title: "Jotform intake",
    text: "New requests arrive automatically through a secured Convex webhook.",
  },
  {
    icon: CalendarCheck2,
    title: "Conflict-aware queue",
    text: "Pending and approved bookings reserve the room; adjacent bookings remain valid.",
  },
  {
    icon: TableProperties,
    title: "Controlled data access",
    text: "Table access is authorized by role, while edits and exports are recorded in the system log.",
  },
];

export default function LandingPage() {
  return (
    <main className="landing">
      <nav className="landing-nav shell-width">
        <Brand />
        <div className="landing-actions">
          <a
            className="text-link hide-mobile"
            href={JOTFORM_FORM_URL}
            target="_blank"
            rel="noreferrer"
          >
            Request a room
          </a>
          <Link href="/sign-in" className="button button-small">
            Admin sign in
          </Link>
        </div>
      </nav>

      <section className="hero shell-width">
        <div className="hero-copy">
          <span className="eyebrow">
            <ShieldCheck size={15} /> Secure booking operations
          </span>
          <h1>
            Room requests,
            <br />
            calmly under control.
          </h1>
          <p>
            One focused workspace for reviewing Jotform requests,
            preventing room conflicts, and managing booking data securely
            in Convex.
          </p>
          <div className="hero-actions">
            <Link href="/sign-in" className="button button-primary">
              Open admin workspace <ArrowRight size={17} />
            </Link>
            <a
              href={JOTFORM_FORM_URL}
              target="_blank"
              rel="noreferrer"
              className="button button-secondary"
            >
              Open booking form
            </a>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="visual-grid" />
          <div className="floating-card card-request">
            <span className="mini-label">NEW REQUEST</span>
            <strong>Board Room</strong>
            <span>Tue, 10:00–11:30</span>
          </div>
          <div className="floating-card card-status">
            <span className="status-dot" />
            <div>
              <strong>No conflict</strong>
              <span>Ready for review</span>
            </div>
          </div>
          <div className="room-orbit orbit-one" />
          <div className="room-orbit orbit-two" />
        </div>
      </section>

      <section className="feature-strip shell-width">
        {features.map(({ icon: Icon, title, text }) => (
          <article key={title}>
            <span className="feature-icon">
              <Icon size={20} />
            </span>
            <div>
              <h2>{title}</h2>
              <p>{text}</p>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
