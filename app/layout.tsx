import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "RoomOps", template: "%s · RoomOps" },
  description: "A secure room-booking operations console powered by Jotform and Convex.",
  appleWebApp: { capable: true, title: "RoomOps", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};
// viewport-fit=cover lets env(safe-area-inset-*) report real notch/home-indicator
// insets; resizes-content makes the Android keyboard shrink the layout like iOS.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#f3f5f6",
  colorScheme: "light",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
