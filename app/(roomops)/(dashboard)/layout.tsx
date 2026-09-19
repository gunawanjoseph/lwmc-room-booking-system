import { auth } from "@clerk/nextjs/server";
import { DeveloperBootstrap } from "@/components/developer-bootstrap";
import { AppShell } from "@/components/app-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await auth.protect();
  return <DeveloperBootstrap><AppShell>{children}</AppShell></DeveloperBootstrap>;
}
