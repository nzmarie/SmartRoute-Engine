import assert from "node:assert/strict";
import test from "node:test";
import {
  ADDRESS_STATUS_COLORS,
  ADDRESS_STATUS_LABELS,
  resolveAddressStatus,
  resolveSimulationDisplayStatus,
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

test("unknown Junk mail stays red until simulated delivery reveals its status", () => {
  assert.equal(resolveSimulationDisplayStatus("junk", false, true), "unsent");
  assert.equal(resolveSimulationDisplayStatus("junk", true, true), "junk");
  assert.equal(resolveSimulationDisplayStatus("unsent", false, true), "unsent");
  assert.equal(resolveSimulationDisplayStatus("unsent", true, true), "sent");
  assert.equal(resolveSimulationDisplayStatus("sent", true, true), "sent");
  assert.equal(resolveSimulationDisplayStatus("junk", false, false), "junk");
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
