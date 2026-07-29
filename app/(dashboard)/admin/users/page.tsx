"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Check,
  Mail,
  Shield,
  Trash2,
  UserRoundCog,
  X,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type Role,
} from "@/shared/roles";
import { formatDateTime, messageFromError } from "@/lib/ui";
import { StatusBadge } from "@/components/status-badge";

const assignableRoles = [
  "booking_viewer",
  "booking_approver",
  "sheet_editor",
  "booking_manager",
] as const;
type AssignableRole = (typeof assignableRoles)[number];

type ManagedUser = {
  _id: Id<"users">;
  displayName: string;
  email: string;
  reason?: string;
  requestedRole?: AssignableRole;
  role: Role;
  roleLabel: string;
  status: "pending" | "active" | "rejected" | "removed";
  isConfiguredHeadAdmin: boolean;
  createdAt: number;
};

type ApproverEmail = {
  _id: Id<"approverEmails">;
  email: string;
  displayName?: string;
  active: boolean;
  updatedAt: number;
};

export default function UserManagementPage() {
  const users = useQuery(api.users.listForManagement) as
    | ManagedUser[]
    | undefined;
  const review = useMutation(api.users.reviewRegistration);
  const changeRole = useMutation(api.users.changeRole);
  const remove = useMutation(api.users.removeUser);
  const approvers = useQuery(api.approvers.list) as
    | ApproverEmail[]
    | undefined;
  const upsertApprover = useMutation(api.approvers.upsert);
  const setApproverActive = useMutation(api.approvers.setActive);
  const removeApprover = useMutation(api.approvers.remove);
  const [roleSelections, setRoleSelections] = useState<
    Record<string, AssignableRole>
  >({});
  const [approverForm, setApproverForm] = useState({
    displayName: "",
    email: "",
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const activeApproverCount = approvers?.filter(
    (approver) => approver.active,
  ).length;

  function selectedRole(user: ManagedUser): AssignableRole {
    return (
      roleSelections[user._id] ??
      user.requestedRole ??
      (user.role === "head_admin" ? "booking_viewer" : user.role)
    );
  }

  async function addApprover(event: React.FormEvent) {
    event.preventDefault();
    await run("approver-form", async () => {
      await upsertApprover({
        email: approverForm.email,
        displayName: approverForm.displayName || undefined,
      });
      setApproverForm({ displayName: "", email: "" });
    });
  }

  async function run(userId: string, operation: () => Promise<unknown>) {
    setBusyId(userId);
    setError("");
    try {
      await operation();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">HEAD ADMINISTRATOR ONLY</span>
          <h1>Administrator management</h1>
          <p>
            Review registrations, assign the least-privileged role, and
            remove access without deleting audit history.
          </p>
        </div>
      </header>

      {error && (
        <div className="form-error page-error" role="alert">
          {error}
        </div>
      )}

      <section className="role-guide">
        {assignableRoles.map((role) => (
          <article key={role}>
            <span className="role-dot" />
            <div>
              <strong>{ROLE_LABELS[role]}</strong>
              <p>{ROLE_DESCRIPTIONS[role]}</p>
            </div>
          </article>
        ))}
      </section>

      <section className="panel table-panel">
        <div className="table-scroll">
          <table className="data-table user-table">
            <thead>
              <tr>
                <th>Administrator</th>
                <th>Request</th>
                <th>Status</th>
                <th>Role</th>
                <th className="align-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!users ? (
                <tr>
                  <td colSpan={5} className="table-message">
                    Loading administrator accounts…
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user._id}>
                    <td>
                      <div className="primary-cell">
                        <strong>
                          {user.displayName}
                          {user.isConfiguredHeadAdmin && (
                            <Shield
                              size={14}
                              className="inline-head-icon"
                            />
                          )}
                        </strong>
                        <span>{user.email}</span>
                        <small>
                          Registered {formatDateTime(user.createdAt)}
                        </small>
                      </div>
                    </td>
                    <td className="request-reason">
                      {user.reason || "No reason provided."}
                      {user.requestedRole && (
                        <small>
                          Requested {ROLE_LABELS[user.requestedRole]}
                        </small>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={user.status} />
                    </td>
                    <td>
                      {user.isConfiguredHeadAdmin ? (
                        <span className="locked-role">
                          <Shield size={14} /> Head Administrator
                        </span>
                      ) : (
                        <select
                          className="role-select"
                          value={selectedRole(user)}
                          disabled={
                            user.status === "removed" ||
                            busyId === user._id
                          }
                          onChange={(event) => {
                            const role = event.target
                              .value as AssignableRole;
                            setRoleSelections((current) => ({
                              ...current,
                              [user._id]: role,
                            }));
                            if (user.status === "active") {
                              void run(user._id, () =>
                                changeRole({
                                  userId: user._id,
                                  role,
                                }),
                              );
                            }
                          }}
                        >
                          {assignableRoles.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {!user.isConfiguredHeadAdmin &&
                          (user.status === "pending" ||
                            user.status === "rejected") && (
                            <>
                              <button
                                className="button button-tiny button-approve"
                                disabled={busyId === user._id}
                                onClick={() =>
                                  void run(user._id, () =>
                                    review({
                                      userId: user._id,
                                      decision: "approve",
                                      role: selectedRole(user),
                                    }),
                                  )
                                }
                              >
                                <Check size={14} /> Approve
                              </button>
                              {user.status === "pending" && (
                                <button
                                  className="icon-button action-reject"
                                  disabled={busyId === user._id}
                                  aria-label={`Reject ${user.displayName}`}
                                  onClick={() =>
                                    void run(user._id, () =>
                                      review({
                                        userId: user._id,
                                        decision: "reject",
                                      }),
                                    )
                                  }
                                >
                                  <X size={16} />
                                </button>
                              )}
                            </>
                          )}
                        {!user.isConfiguredHeadAdmin &&
                          user.status !== "removed" && (
                            <button
                              className="icon-button action-reject"
                              disabled={busyId === user._id}
                              aria-label={`Remove ${user.displayName}`}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Remove ${user.displayName}'s RoomOps access? Their Clerk identity and audit history will remain.`,
                                  )
                                ) {
                                  void run(user._id, () =>
                                    remove({ userId: user._id }),
                                  );
                                }
                              }}
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        {user.isConfiguredHeadAdmin && (
                          <span className="view-only-label">
                            <UserRoundCog size={14} /> Protected
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className="panel approver-management-panel"
        aria-labelledby="approver-management-title"
      >
        <div className="panel-heading approver-management-heading">
          <div className="approver-management-title">
            <span className="panel-kicker">EMAIL APPROVERS</span>
            <h2 id="approver-management-title">
              Approver email management
            </h2>
          </div>
          <span
            className="approver-count-pill"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={
              activeApproverCount === undefined
                ? "Loading active email approvers"
                : `${activeApproverCount} active email approver${
                    activeApproverCount === 1 ? "" : "s"
                  }`
            }
          >
            <Mail size={16} aria-hidden="true" />
            {activeApproverCount === undefined
              ? "Loading…"
              : `${activeApproverCount} active`}
          </span>
        </div>
        <form
          className="approver-form"
          onSubmit={addApprover}
          aria-label="Add an email approver"
        >
          <label className="field">
            <span>Name</span>
            <input
              autoComplete="name"
              value={approverForm.displayName}
              onChange={(event) =>
                setApproverForm((current) => ({
                  ...current,
                  displayName: event.target.value,
                }))
              }
              placeholder="Optional display name"
            />
          </label>
          <label className="field">
            <span>Email</span>
            <input
              required
              type="email"
              autoComplete="email"
              value={approverForm.email}
              onChange={(event) =>
                setApproverForm((current) => ({
                  ...current,
                  email: event.target.value,
                }))
              }
              placeholder="approver@example.com"
            />
          </label>
          <button
            className="button button-primary"
            disabled={busyId === "approver-form"}
          >
            {busyId === "approver-form" ? "Adding…" : "Add approver"}
          </button>
        </form>
        <div
          className="approver-list"
          aria-busy={approvers === undefined}
        >
          {!approvers ? (
            <div className="table-message approver-empty">
              Loading approver emails…
            </div>
          ) : approvers.length === 0 ? (
            <div className="table-message approver-empty">
              No approver emails configured yet.
            </div>
          ) : (
            approvers.map((approver) => (
              <article
                key={approver._id}
                className={
                  approver.active
                    ? "approver-row"
                    : "approver-row approver-row-inactive"
                }
              >
                <div className="approver-identity">
                  <span className="approver-avatar" aria-hidden="true">
                    {(approver.displayName || approver.email)
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                  <div>
                    <strong>
                      {approver.displayName || approver.email}
                    </strong>
                    <span>{approver.email}</span>
                    <small>
                      Updated {formatDateTime(approver.updatedAt)}
                    </small>
                  </div>
                </div>
                <div className="approver-row-actions">
                  <StatusBadge
                    status={approver.active ? "active" : "removed"}
                  />
                  <button
                    type="button"
                    className="button button-small button-secondary"
                    disabled={busyId === approver._id}
                    aria-label={`${
                      approver.active ? "Deactivate" : "Reactivate"
                    } ${approver.displayName || approver.email} as an email approver`}
                    onClick={() =>
                      void run(approver._id, () =>
                        setApproverActive({
                          approverId: approver._id,
                          active: !approver.active,
                        }),
                      )
                    }
                  >
                    {approver.active ? "Deactivate" : "Reactivate"}
                  </button>
                  {!approver.active && (
                    <button
                      type="button"
                      className="icon-button action-reject"
                      disabled={busyId === approver._id}
                      aria-label={`Permanently remove ${
                        approver.displayName || approver.email
                      } as an email approver`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Permanently remove ${
                              approver.displayName || approver.email
                            }? This deletes the approver record from Convex and cannot be undone.`,
                          )
                        ) {
                          void run(approver._id, () =>
                            removeApprover({ approverId: approver._id }),
                          );
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}