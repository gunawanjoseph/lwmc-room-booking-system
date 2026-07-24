"use client";

import Link from "next/link";
import { useState } from "react";
import {
  useConvexAuth,
  useMutation,
  useQuery,
} from "convex/react";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type Role,
} from "@/shared/roles";
import { messageFromError } from "@/lib/ui";
import { Brand } from "@/components/brand";

const requestableRoles = [
  "booking_viewer",
  "booking_approver",
  "sheet_editor",
  "booking_manager",
] as const;

export default function RegistrationPage() {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const profile = useQuery(
    api.users.me,
    isAuthenticated ? {} : "skip",
  );
  const submitRegistration = useMutation(api.users.submitRegistration);
  const [displayName, setDisplayName] = useState("");
  const [reason, setReason] = useState("");
  const [requestedRole, setRequestedRole] =
    useState<(typeof requestableRoles)[number]>("booking_viewer");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await submitRegistration({
        displayName,
        reason: reason || undefined,
        requestedRole,
      });
      setSubmitted(true);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || !isAuthenticated || profile === undefined) {
    return (
      <main className="state-page">
        <span className="loading-ring" />
        <p>Loading your administrator registration…</p>
      </main>
    );
  }

  if (profile?.status === "active" || submitted) {
    return (
      <main className="state-page">
        <div className="state-card">
          <Brand />
          <CheckCircle2 className="success-icon" size={36} />
          <h1>
            {profile?.status === "active"
              ? "Your account is active"
              : "Access request submitted"}
          </h1>
          <p>
            {profile?.status === "active"
              ? "You can open the administrator workspace now."
              : "The Head Administrator can now review your registration and assign your final role."}
          </p>
          <Link href="/home" className="button button-primary">
            Continue <ArrowRight size={17} />
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="registration-page">
      <header className="registration-header">
        <Brand />
        <Link href="/sign-in" className="text-link">
          Back to sign in
        </Link>
      </header>
      <section className="registration-layout">
        <div className="registration-copy">
          <span className="eyebrow">ADMIN REGISTRATION</span>
          <h1>Tell the Head Administrator what access you need.</h1>
          <p>
            Your requested role is a recommendation only. The Head
            Administrator assigns the final role when approving your
            account.
          </p>
        </div>
        <form className="panel registration-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Display name</span>
            <input
              required
              minLength={2}
              maxLength={100}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="e.g. Alex Tan"
            />
          </label>
          <label className="field">
            <span>Requested role</span>
            <select
              value={requestedRole}
              onChange={(event) =>
                setRequestedRole(event.target.value as typeof requestedRole)
              }
            >
              {requestableRoles.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role as Role]}
                </option>
              ))}
            </select>
            <small>{ROLE_DESCRIPTIONS[requestedRole]}</small>
          </label>
          <label className="field">
            <span>Why do you need access?</span>
            <textarea
              maxLength={500}
              rows={4}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Describe your booking responsibilities."
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button
            className="button button-primary button-full"
            disabled={busy}
          >
            {busy ? "Submitting…" : "Submit access request"}
          </button>
        </form>
      </section>
    </main>
  );
}
