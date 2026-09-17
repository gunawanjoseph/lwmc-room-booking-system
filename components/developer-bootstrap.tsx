"use client";

import { useAuth } from "@clerk/nextjs";
import { useConvexAuth, useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { messageFromError } from "@/lib/ui";

/** Provision the configured developer before account/status routing runs. */
export function DeveloperBootstrap({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const ensureDeveloper = useMutation(api.users.ensureDeveloper);
  const [checkedUser, setCheckedUser] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    let active = true;
    void ensureDeveloper({}).then(() => {
      if (active) { setError(""); setCheckedUser(userId); }
    }).catch(caught => {
      if (active) setError(messageFromError(caught));
    });
    return () => { active = false; };
  }, [isAuthenticated, userId, ensureDeveloper, attempt]);
  if (!isAuthenticated) return children;
  if (error) return <main className="state-page"><div className="state-card">
    <h1>Unable to check account access</h1><p role="alert">{error}</p>
    <button className="button button-primary" onClick={() => { setError(""); setCheckedUser(null); setAttempt(value => value + 1); }}>Retry</button>
  </div></main>;
  if (checkedUser !== userId) return <main className="state-page"><p role="status">Checking account access…</p></main>;
  return children;
}
