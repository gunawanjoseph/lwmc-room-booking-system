export const ROLES = [
  "head_admin",
  "booking_viewer",
  "booking_approver",
  "sheet_editor",
  "booking_manager",
  "tech_support",
] as const;

export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  "bookings.view",
  "bookings.approve",
  "bookings.edit",
  "table.view",
  "table.edit",
  "bookings.export",
  "logs.view",
  "users.manage",
  "integrations.manage",
  "support.view",
  "support.develop",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  head_admin: "Head Administrator",
  tech_support: "Technical Support",
  booking_viewer: "Booking Viewer",
  booking_approver: "Booking Approver",
  sheet_editor: "Data Editor",
  booking_manager: "Booking Manager",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  tech_support: "Can respond to support conversations and publish updates, without access to bookings, user management or integrations.",
  head_admin:
    "Full control of users, integrations, bookings, the data table, exports, and logs.",
  booking_viewer:
    "Can view bookings, the data table, export workbooks, and view logs.",
  booking_approver:
    "Can view and export data, then approve or reject booking requests.",
  sheet_editor:
    "Can edit or delete booking rows, including requester details, Calendar title fields, and dynamic form fields.",
  booking_manager:
    "Can approve or reject requests, and edit or delete booking records and table metadata.",
};

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  head_admin: CAPABILITIES,
  tech_support: ["support.view", "support.develop"],
  booking_viewer: [
    "bookings.view",
    "table.view",
    "bookings.export",
    "logs.view",
    "support.view",
  ],
  booking_approver: [
    "bookings.view",
    "bookings.approve",
    "table.view",
    "bookings.export",
    "logs.view",
    "support.view",
  ],
  sheet_editor: [
    "bookings.view",
    "table.view",
    "table.edit",
    "bookings.export",
    "logs.view",
    "support.view",
  ],
  booking_manager: [
    "bookings.view",
    "bookings.approve",
    "bookings.edit",
    "table.view",
    "table.edit",
    "bookings.export",
    "logs.view",
    "support.view",
  ],
};

export function capabilitiesForRole(role: Role): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function roleHasCapability(
  role: Role,
  capability: Capability,
): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}
