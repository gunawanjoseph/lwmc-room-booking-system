import { PublicProviders } from "@/components/public-providers";
import { PublicBookings } from "@/components/public-bookings";

// Public and embeddable (the LWMC leaders' portal frames it). It lives outside
// the Clerk-wrapped (roomops) group and is skipped by the Clerk proxy: a Clerk
// development instance redirects cookie-less visitors to *.clerk.accounts.dev,
// which forbids framing, and iOS Safari never sends cookies into frames.
export default function BookingCalendarPage() {
  return <PublicProviders><PublicBookings/></PublicProviders>;
}
