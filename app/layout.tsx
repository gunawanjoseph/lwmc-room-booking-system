import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "RoomOps", template: "%s · RoomOps" },
  description: "A secure room-booking operations console powered by Jotform and Convex.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
