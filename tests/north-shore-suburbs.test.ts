import assert from "node:assert/strict";
import test from "node:test";
import {
  isNorthShoreSuburb,
  NORTH_SHORE_SUBURBS,
} from "../src/lib/north-shore-suburbs.ts";

test("includes Albany and the expected North Shore suburbs", () => {
  assert.ok(NORTH_SHORE_SUBURBS.includes("Albany"));
  assert.equal(isNorthShoreSuburb("Albany"), true);
  assert.equal(isNorthShoreSuburb("  aLbAnY  "), true);
});

test("rejects empty values and suburbs outside the configured region", () => {
  assert.equal(isNorthShoreSuburb(""), false);
  assert.equal(isNorthShoreSuburb("Auckland Central"), false);
});
