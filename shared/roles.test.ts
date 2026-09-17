import { describe, expect, it } from "vitest";
import { CAPABILITIES, ROLES, roleHasCapability } from "./roles";

describe("role capability matrix", () => {
  it("reserves publishing for the developer while preserving head administration", () => {
    for (const role of ["head_admin", "developer"] as const) {
      for (const capability of CAPABILITIES) expect(roleHasCapability(role, capability)).toBe(role === "developer" || capability !== "support.publish");
    }
  });
  it("does not grant access through the obsolete assignable developer role", () => {
    for (const capability of CAPABILITIES) expect(roleHasCapability("tech_support", capability)).toBe(false);
  });
  it("preserves administrator permissions while allowing developer access", () => {
    for (const role of ROLES) {
      expect(roleHasCapability(role, "table.edit")).toBe(["head_admin", "developer", "sheet_editor", "booking_manager"].includes(role));
      expect(roleHasCapability(role, "users.manage")).toBe(["head_admin", "developer"].includes(role));
      expect(roleHasCapability(role, "support.publish")).toBe(role === "developer");
      expect(roleHasCapability(role, "support.develop")).toBe(["head_admin", "developer"].includes(role));
      expect(roleHasCapability(role, "support.view")).toBe(role !== "tech_support");
      expect(roleHasCapability(role, "table.view")).toBe(role !== "tech_support");
      expect(roleHasCapability(role, "bookings.export")).toBe(role !== "tech_support");
    }
    expect(roleHasCapability("sheet_editor", "bookings.edit")).toBe(false);
    expect(roleHasCapability("booking_manager", "bookings.edit")).toBe(true);
  });
});
