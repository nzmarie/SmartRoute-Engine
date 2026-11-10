import assert from "node:assert/strict";
import test from "node:test";
import { defaultPeriodKey, periodKey, type ReportingPeriod } from "../src/lib/outreach-period.ts";

const periods: ReportingPeriod[] = [
  { year: 2026, quarter: "Q2" },
  { year: 2026, quarter: "Q3" },
];

test("creates a stable key for a reporting period", () => {
  assert.equal(periodKey({ year: 2026, quarter: "Q3" }), "2026:Q3");
});

test("prefers Q3 2026 when available", () => {
  assert.equal(defaultPeriodKey(periods), "2026:Q3");
});

test("falls back to the first available period when Q3 2026 is absent", () => {
  assert.equal(defaultPeriodKey([periods[0]]), "2026:Q2");
});

test("uses all history when there are no reporting periods", () => {
  assert.equal(defaultPeriodKey([]), "all");
});
