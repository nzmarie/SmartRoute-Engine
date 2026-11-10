import assert from "node:assert/strict";
import test from "node:test";
import { processMapAddressRows, type MapAddressRow } from "../src/lib/map-address-results.ts";

function row(overrides: Partial<MapAddressRow> = {}): MapAddressRow {
  return {
    address_key: "address-1",
    address: "1 Example Street, Albany",
    latitude: -36.731,
    longitude: 174.705,
    is_junk: false,
    has_sent: false,
    ...overrides,
  };
}

test("maps valid points and counts each derived status", () => {
  const result = processMapAddressRows([
    row(),
    row({ address_key: "address-2", has_sent: true }),
    row({ address_key: "address-3", is_junk: true, has_sent: true }),
  ]);

  assert.deepEqual(result.points, [
    { address: "1 Example Street, Albany", lat: -36.731, lng: 174.705, status: "unsent" },
    { address: "1 Example Street, Albany", lat: -36.731, lng: 174.705, status: "sent" },
    { address: "1 Example Street, Albany", lat: -36.731, lng: 174.705, status: "junk" },
  ]);
  assert.deepEqual(result.summary, {
    total: 3,
    mapped: 3,
    missingCoordinates: 0,
    states: { unsent: 1, sent: 1, junk: 1 },
  });
});

test("counts an address status even when its coordinates are missing", () => {
  const result = processMapAddressRows([
    row({ latitude: null }),
    row({ address_key: "address-2", longitude: null, has_sent: true }),
  ]);

  assert.deepEqual(result.points, []);
  assert.deepEqual(result.summary, {
    total: 2,
    mapped: 0,
    missingCoordinates: 2,
    states: { unsent: 1, sent: 1, junk: 0 },
  });
});

test("rejects non-finite and out-of-range coordinates", () => {
  const result = processMapAddressRows([
    row({ latitude: Number.NaN }),
    row({ latitude: Number.POSITIVE_INFINITY }),
    row({ latitude: -90.01 }),
    row({ latitude: 90.01 }),
    row({ longitude: -180.01 }),
    row({ longitude: 180.01 }),
  ]);

  assert.equal(result.points.length, 0);
  assert.equal(result.summary.missingCoordinates, 6);
});

test("accepts coordinates at the valid latitude and longitude boundaries", () => {
  const result = processMapAddressRows([
    row({ latitude: -90, longitude: -180 }),
    row({ address_key: "address-2", latitude: 90, longitude: 180 }),
  ]);

  assert.equal(result.points.length, 2);
  assert.equal(result.summary.missingCoordinates, 0);
});

test("returns an empty summary for no addresses", () => {
  assert.deepEqual(processMapAddressRows([]), {
    points: [],
    summary: {
      total: 0,
      mapped: 0,
      missingCoordinates: 0,
      states: { unsent: 0, sent: 0, junk: 0 },
    },
  });
});
