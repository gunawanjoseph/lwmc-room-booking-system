import { auth } from "@clerk/nextjs/server";
import { AppShell } from "@/components/app-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await auth.protect();
  return <AppShell>{children}</AppShell>;
}
