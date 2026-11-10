import assert from "node:assert/strict";
import test from "node:test";
import {
  ADDRESS_STATUS_COLORS,
  ADDRESS_STATUS_LABELS,
  resolveAddressStatus,
} from "../src/lib/address-status.ts";

test("Junk mail takes precedence over a recorded send", () => {
  assert.equal(resolveAddressStatus(true, true), "junk");
});

test("a sent address is purple-state unless it is Junk mail", () => {
  assert.equal(resolveAddressStatus(false, true), "sent");
});

test("an address without a send or Junk flag is Unsent", () => {
  assert.equal(resolveAddressStatus(false, false), "unsent");
});

test("exports the expected map legend labels and colors", () => {
  assert.deepEqual(ADDRESS_STATUS_LABELS, {
    unsent: "Unsent",
    sent: "Sent",
    junk: "Junk mail",
  });
  assert.deepEqual(ADDRESS_STATUS_COLORS, {
    unsent: "#dc2626",
    sent: "#7c3aed",
    junk: "#eab308",
  });
});
