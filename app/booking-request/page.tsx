import type { Metadata } from "next";
import { PublicProviders } from "@/components/public-providers";
import { RequestBooking } from "@/components/request-booking";
export const metadata: Metadata = { title: "Manage your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function Page() {
  return <PublicProviders><RequestBooking /></PublicProviders>;
}
