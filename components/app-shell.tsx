"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import {
  BookOpenCheck,
  CalendarDays,
  ChevronRight,
  FileClock,
  Home,
  Menu,
  Settings2,
  TableProperties,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Capability, Role } from "@/shared/roles";
import { Brand } from "./brand";
import { StatusBadge } from "./status-badge";

type CurrentUser = {
  displayName: string;
  email: string;
  role: Role;
  roleLabel: string;
  status: "pending" | "active" | "rejected" | "removed";
  capabilities: Capability[];
  isConfiguredHeadAdmin: boolean;
};

const navigation: Array<{
  href: string;
  label: string;
  icon: typeof Home;
  capability?: Capability;
}> = [
  { href: "/home", label: "Overview", icon: Home },
  {
    href: "/bookings",
    label: "Bookings",
    icon: BookOpenCheck,
    capability: "bookings.view",
  },
  {
    href: "/calendar",
    label: "Calendar",
    icon: CalendarDays,
    capability: "bookings.view",
  },
  {
    href: "/sheet",
    label: "Booking data",
    icon: TableProperties,
    capability: "table.view",
  },
  {
    href: "/logs",
    label: "System logs",
    icon: FileClock,
    capability: "logs.view",
  },
  {
    href: "/admin/users",
    label: "Admin management",
    icon: Users,
    capability: "users.manage",
  },
  {
    href: "/admin/integrations",
    label: "Integrations",
    icon: Settings2,
    capability: "integrations.manage",
  },
];

function LoadingShell() {
  return (
    <main className="state-page">
      <span className="loading-ring" />
      <p>Opening your workspace…</p>
    </main>
  );
}

function InactiveAccount({ user }: { user: CurrentUser }) {
  const copy = {
    pending: {
      title: "Your access request is being reviewed",
      text: "The Head Administrator needs to approve your account and assign a role before you can enter the workspace.",
    },
    rejected: {
      title: "Your access request was not approved",
      text: "Contact the Head Administrator if your responsibilities have changed or you think this is a mistake.",
    },
    removed: {
      title: "Your administrator access was removed",
      text: "This identity can no longer open the room-booking workspace.",
    },
    active: { title: "", text: "" },
  }[user.status];

  return (
    <main className="state-page">
      <div className="state-card">
        <Brand />
        <StatusBadge status={user.status} />
        <h1>{copy.title}</h1>
        <p>{copy.text}</p>
        <div className="identity-line">
          <span>{user.displayName}</span>
          <small>{user.email}</small>
        </div>
        <UserButton />
      </div>
    </main>
  );
}

function FormerHeadAdministrator({ user }: { user: CurrentUser }) {
  return (
    <main className="state-page">
      <div className="state-card">
        <Brand />
        <span className="eyebrow">ACCESS UPDATED</span>
        <h1>Head Administrator access has changed</h1>
        <p>
          This account is no longer the configured Head Administrator.
          Contact the current Head Administrator if you still need a
          lower administrator role.
        </p>
        <div className="identity-line">
          <span>{user.displayName}</span>
          <small>{user.email}</small>
        </div>
        <UserButton />
      </div>
    </main>
  );
}

function ForbiddenRoute() {
  return (
    <main className="state-page">
      <div className="state-card">
        <Brand />
        <span className="eyebrow">ACCESS RESTRICTED</span>
        <h1>You do not have permission to open this page</h1>
        <p>
          Your assigned role does not include the capability required by
          this route.
        </p>
        <Link href="/home" className="button button-primary">
          Return to overview <ChevronRight size={17} />
        </Link>
      </div>
    </main>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const profile = useQuery(
    api.users.me,
    isAuthenticated ? {} : "skip",
  ) as
    | CurrentUser
    | null
    | undefined;
  const [mobileOpen, setMobileOpen] = useState(false);

  if (authLoading || !isAuthenticated || profile === undefined) {
    return <LoadingShell />;
  }
  if (profile === null) {
    return (
      <main className="state-page">
        <div className="state-card">
          <Brand />
          <span className="eyebrow">ONE MORE STEP</span>
          <h1>Submit your administrator request</h1>
          <p>
            Your Clerk identity is ready, but no RoomOps account request
            has been submitted yet.
          </p>
          <Link href="/register" className="button button-primary">
            Complete registration <ChevronRight size={17} />
          </Link>
        </div>
      </main>
    );
  }
  if (profile.status !== "active") {
    return <InactiveAccount user={profile} />;
  }
  if (
    profile.role === "head_admin" &&
    !profile.isConfiguredHeadAdmin
  ) {
    return <FormerHeadAdministrator user={profile} />;
  }

  const allowedNavigation = navigation.filter(
    (item) =>
      !item.capability ||
      profile.capabilities.includes(item.capability),
  );
  const routeCapability = navigation.find(
    (item) =>
      item.capability &&
      (pathname === item.href ||
        pathname.startsWith(`${item.href}/`)),
  )?.capability;

  if (
    routeCapability &&
    !profile.capabilities.includes(routeCapability)
  ) {
    return <ForbiddenRoute />;
  }

  return (
    <div className="workspace">
      <button
        className="mobile-menu-button"
        aria-label="Open navigation"
        onClick={() => setMobileOpen(true)}
      >
        <Menu size={20} />
      </button>
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <Brand compact />
          <button
            className="icon-button sidebar-close"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <nav className="sidebar-nav">
          {allowedNavigation.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== "/home" &&
                pathname.startsWith(`${item.href}/`));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "nav-link nav-link-active" : "nav-link"}
                onClick={() => setMobileOpen(false)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-user">
          <UserButton />
          <div>
            <strong>{profile.displayName}</strong>
            <span>{profile.roleLabel}</span>
          </div>
        </div>
      </aside>
      <main className="workspace-main">{children}</main>
    </div>
  );
}
