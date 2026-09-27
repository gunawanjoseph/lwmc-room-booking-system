"use client";
import { useState, type ReactNode } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
export function PublicProviders({ children }: { children: ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!));
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
