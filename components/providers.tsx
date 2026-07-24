"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  ConvexProviderWithClerk,
} from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [convex] = useState(
    () =>
      new ConvexReactClient(
        process.env.NEXT_PUBLIC_CONVEX_URL ??
          "https://configuration-required.convex.cloud",
      ),
  );

  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
