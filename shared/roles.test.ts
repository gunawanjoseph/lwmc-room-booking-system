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

  it("lets every active administrator view and export the table", () => {
    for (const role of ROLES) {
      expect(roleHasCapability(role, "table.view")).toBe(true);
      expect(roleHasCapability(role, "bookings.export")).toBe(true);
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
