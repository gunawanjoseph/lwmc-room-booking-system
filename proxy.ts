import { clerkMiddleware } from "@clerk/nextjs/server";

// Authentication is enforced by the server layouts that own protected
// resources. The proxy only makes Clerk's request auth state available.
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
const clerk = clerkMiddleware();
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // Public pages never touch Clerk, so they load inside third-party frames
  // (Google Sites) where iOS blocks cookies.
  const path = request.nextUrl.pathname.replace(/\/$/, "");
  if (path === "/booking-request" || path === "/booking-calendar") return NextResponse.next();
  return clerk(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
