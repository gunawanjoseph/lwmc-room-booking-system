import { describe, expect, it } from "vitest";
import { CAPABILITIES, ROLES, roleHasCapability } from "./roles";

describe("role capability matrix", () => {
  it("gives the head administrator every capability", () => {
    for (const capability of CAPABILITIES) {
      expect(roleHasCapability("head_admin", capability)).toBe(true);
    }
  });

  it("limits table editing and safe row deletion to data roles", () => {
    for (const role of ROLES) {
      expect(roleHasCapability(role, "table.edit")).toBe(
        role === "head_admin" ||
          role === "sheet_editor" ||
          role === "booking_manager",
      );
    }
    expect(roleHasCapability("sheet_editor", "bookings.edit")).toBe(false);
    expect(roleHasCapability("booking_manager", "bookings.edit")).toBe(true);
  });

  it("lets booking administrators, but not support-only developers, view and export the table", () => {
    for (const role of ROLES) {
      expect(roleHasCapability(role, "table.view")).toBe(role !== "tech_support");
      expect(roleHasCapability(role, "bookings.export")).toBe(role !== "tech_support");
    }
  });

  it("keeps developer permissions separate from booking operations", () => {
    for (const capability of CAPABILITIES) {
      expect(roleHasCapability("tech_support", capability)).toBe(
        capability === "support.view" || capability === "support.develop",
      );
    }
    for (const role of ROLES) {
      expect(roleHasCapability(role, "support.view")).toBe(true);
      expect(roleHasCapability(role, "support.develop")).toBe(
        role === "head_admin" || role === "tech_support",
      );
    }
  });

  it("only gives user management to the head administrator", () => {
    for (const role of ROLES) {
      expect(roleHasCapability(role, "users.manage")).toBe(
        role === "head_admin",
      );
    }
  });
});
