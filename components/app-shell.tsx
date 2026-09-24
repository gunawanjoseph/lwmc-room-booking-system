"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import {
  BookOpenCheck,
  CalendarDays,
  ChevronRight,
  FilePen,
  FileClock,
  Home,
  Menu,
  MessagesSquare,
  MoreHorizontal,
  Settings2,
  TableProperties,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import {
  claimPendingConflictEdges,
  detectBookingConflictTransition,
  type BookingConflictSnapshot,
} from "@/lib/booking-conflict-transition";
import type { Capability, Role } from "@/shared/roles";
import { Brand } from "./brand";
import { StatusBadge } from "./status-badge";
import { useDrawerGesture, useMediaQuery } from "./use-drawer-gesture";

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
  { href: "/home", label: "Overview", icon: Home, capability: "bookings.view" },
  {
    href: "/bookings",
    label: "Bookings",
    icon: BookOpenCheck,
    capability: "bookings.view",
  },
  { href: "/booking-requests", label: "Edit Requests", icon: FilePen, capability: "bookings.approve" },
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
  { href: "/support", label: "Support", icon: MessagesSquare, capability: "support.view" },
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

// Phones get a bottom tab bar with the most-used destinations that the
// signed-in role can open; everything else lives behind "More".
const tabPriority = ["/home", "/bookings", "/calendar", "/booking-requests", "/support"];
const TAB_COUNT = 4;

function isActiveRoute(pathname: string, href: string) {
  return (
    pathname === href ||
    (href !== "/home" && pathname.startsWith(`${href}/`))
  );
}

type ConflictToastBooking = {
  _id: string;
  requesterName: string;
  room: string;
  revision: number;
  updatedAt: number;
  calendarAvailabilityStatus?:
    | "unchecked"
    | "available"
    | "conflict";
  calendarConflictSummary?: string;
  calendarSyncStatus?:
    | "disabled"
    | "not_created"
    | "creating"
    | "synced"
    | "failed"
    | "conflict";
  conflictWarningBookingIds?: string[];
};

type ConflictToast = {
  id: string;
  message: string;
  title: string;
};

function conflictSnapshot(
  booking: ConflictToastBooking,
): BookingConflictSnapshot {
  return {
    id: String(booking._id),
    revision: booking.revision,
    updatedAt: booking.updatedAt,
    calendarAvailabilityStatus:
      booking.calendarAvailabilityStatus,
    calendarConflictSummary: booking.calendarConflictSummary,
    calendarSyncStatus: booking.calendarSyncStatus,
    conflictWarningBookingIds:
      booking.conflictWarningBookingIds?.map(String),
  };
}

function ConflictToastMonitor({ enabled }: { enabled: boolean }) {
  const bookings = useQuery(
    api.bookings.listConflictNotificationFeed,
    enabled ? {} : "skip",
  ) as ConflictToastBooking[] | undefined;
  const previousRef = useRef<
    Map<string, BookingConflictSnapshot> | undefined
  >(undefined);
  const seenRef = useRef(new Set<string>());
  const publishTimersRef = useRef(
    new Set<ReturnType<typeof setTimeout>>(),
  );
  const timersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const [toasts, setToasts] = useState<ConflictToast[]>([]);

  useEffect(() => {
    if (!bookings) return;
    const next = new Map(
      bookings.map((booking) => [
        String(booking._id),
        conflictSnapshot(booking),
      ]),
    );
    const previous = previousRef.current;
    previousRef.current = next;
    if (!previous) return;

    const additions: ConflictToast[] = [];
    const claimedPendingEdges = new Set<string>();
    for (const booking of bookings) {
      const bookingId = String(booking._id);
      const transition = detectBookingConflictTransition(
        previous.get(bookingId),
        next.get(bookingId)!,
      );
      if (!transition) continue;

      if (transition.kind === "pending") {
        const conflictBookingIds = claimPendingConflictEdges(
          bookingId,
          transition.addedPendingConflictBookingIds,
          claimedPendingEdges,
        );
        if (
          conflictBookingIds.length === 0 ||
          seenRef.current.has(transition.key)
        ) {
          continue;
        }
        additions.push({
          id: transition.key,
          title: "Pending booking conflict",
          message: `${booking.room} for ${booking.requesterName} now overlaps ${conflictBookingIds.length} additional pending ${
            conflictBookingIds.length === 1 ? "request" : "requests"
          }.`,
        });
        continue;
      }

      if (seenRef.current.has(transition.key)) continue;
      additions.push({
        id: transition.key,
        title: "Calendar conflict detected",
        message: `${booking.room} for ${booking.requesterName} conflicts with an existing Calendar event.${
          booking.calendarConflictSummary
            ? ` ${booking.calendarConflictSummary}`
            : ""
        }`,
      });
    }
    if (additions.length === 0) return;

    for (const toast of additions) {
      seenRef.current.add(toast.id);
    }
    const publishTimer = setTimeout(() => {
      publishTimersRef.current.delete(publishTimer);
      setToasts((current) => [...current, ...additions].slice(-4));
      for (const toast of additions) {
        const timer = setTimeout(() => {
          timersRef.current.delete(toast.id);
          setToasts((current) =>
            current.filter((item) => item.id !== toast.id),
          );
        }, 10_000);
        timersRef.current.set(toast.id, timer);
      }
    }, 0);
    publishTimersRef.current.add(publishTimer);
  }, [bookings]);

  useEffect(
    () => () => {
      for (const timer of publishTimersRef.current) {
        clearTimeout(timer);
      }
      publishTimersRef.current.clear();
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
    },
    [],
  );

  function dismissToast(toastId: string) {
    const timer = timersRef.current.get(toastId);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(toastId);
    setToasts((current) =>
      current.filter((toast) => toast.id !== toastId),
    );
  }

  if (toasts.length === 0) return null;

  return (
    <aside
      className="conflict-toast-stack"
      aria-label="Booking conflict notifications"
      aria-live="assertive"
      aria-relevant="additions"
    >
      {toasts.map((toast) => (
        <div
          className="conflict-toast"
          key={toast.id}
          role="alert"
          aria-atomic="true"
        >
          <TriangleAlert size={20} aria-hidden="true" />
          <div className="conflict-toast-copy">
            <strong>{toast.title}</strong>
            <span>{toast.message}</span>
            <Link
              href="/bookings"
              className="text-link"
              onClick={() => dismissToast(toast.id)}
            >
              Review bookings
            </Link>
          </div>
          <button
            type="button"
            className="icon-button conflict-toast-close"
            aria-label={`Dismiss ${toast.title}`}
            onClick={() => dismissToast(toast.id)}
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </aside>
  );
}

function LoadingShell() {
  return (
    <main className="state-page">
      <span className="loading-ring" />
      <p>Opening your workspace…</p>
    </main>
  );
}

function InactiveAccount({ user }: { user: CurrentUser }) {
  const copy = user.role === "developer" || user.role === "tech_support" ? {
    title: "Developer access is not active",
    text: "Sign in using the verified email configured as DEVELOPER_EMAIL in Convex. This account cannot be activated by the Head Administrator.",
  } : {
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

function ForbiddenRoute({ home = "/home" }: { home?: string }) {
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
        <Link href={home} className="button button-primary">
          Return to workspace <ChevronRight size={17} />
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
  const compact = useMediaQuery("(max-width: 850px)");
  const drawerRef = useRef<HTMLElement>(null);
  const scrimRef = useRef<HTMLButtonElement>(null);
  const closeDrawer = useCallback(() => setMobileOpen(false), []);
  const drawerOpen = compact && mobileOpen;
  useDrawerGesture({
    drawer: drawerRef,
    scrim: scrimRef,
    enabled: drawerOpen,
    onClose: closeDrawer,
  });
  useEffect(() => {
    if (!drawerOpen) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

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

  const tabs = tabPriority
    .map((href) => allowedNavigation.find((item) => item.href === href))
    .filter((item): item is (typeof navigation)[number] => Boolean(item))
    .slice(0, TAB_COUNT);
  const currentTitle =
    allowedNavigation.find((item) => isActiveRoute(pathname, item.href))
      ?.label ?? "RoomOps";
  const moreActive = !tabs.some((item) => isActiveRoute(pathname, item.href));

  return (
    <div className={`workspace${drawerOpen ? " workspace-drawer-open" : ""}`}>
      <ConflictToastMonitor
        enabled={profile.capabilities.includes("bookings.view")}
      />
      <header className="mobile-topbar">
        <button
          className="mobile-menu-button"
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          onClick={() => setMobileOpen(true)}
        >
          <Menu size={20} />
        </button>
        <span className="mobile-topbar-title">{currentTitle}</span>
        <span className="mobile-topbar-spacer" aria-hidden="true" />
      </header>
      <button
        ref={scrimRef}
        className="sidebar-scrim"
        aria-label="Close navigation"
        tabIndex={drawerOpen ? 0 : -1}
        aria-hidden={!drawerOpen}
        onClick={() => setMobileOpen(false)}
      />
      <aside
        ref={drawerRef}
        className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}
        inert={compact && !mobileOpen}
        aria-label="Workspace navigation"
      >
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
            const active = isActiveRoute(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "nav-link nav-link-active" : "nav-link"}
                aria-current={active ? "page" : undefined}
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
      <nav className="tabbar" aria-label="Primary">
        {tabs.map((item) => {
          const active = isActiveRoute(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="tabbar-link"
              aria-current={active ? "page" : undefined}
            >
              <Icon size={22} strokeWidth={active ? 2.3 : 1.8} />
              <span>{item.href === "/booking-requests" ? "Requests" : item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className="tabbar-link"
          aria-current={moreActive ? "page" : undefined}
          aria-expanded={drawerOpen}
          onClick={() => setMobileOpen(true)}
        >
          <MoreHorizontal size={22} strokeWidth={moreActive ? 2.3 : 1.8} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
