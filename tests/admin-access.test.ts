import assert from "node:assert/strict";
import test from "node:test";
import { hasConfiguredAdminAllowlist, isAllowedAdmin } from "../src/lib/admin-access.ts";

test("admin access rejects missing email and an empty allowlist", () => {
  const previous = process.env.SMARTROUTE_ADMIN_EMAILS;
  delete process.env.SMARTROUTE_ADMIN_EMAILS;

  try {
    assert.equal(hasConfiguredAdminAllowlist(), false);
    assert.equal(isAllowedAdmin(null), false);
    assert.equal(isAllowedAdmin(undefined), false);
    assert.equal(isAllowedAdmin(""), false);
    assert.equal(isAllowedAdmin("admin@example.com"), false);
  } finally {
    if (previous === undefined) delete process.env.SMARTROUTE_ADMIN_EMAILS;
    else process.env.SMARTROUTE_ADMIN_EMAILS = previous;
  }
});

test("admin access normalizes and checks the configured email allowlist", () => {
  const previous = process.env.SMARTROUTE_ADMIN_EMAILS;
  process.env.SMARTROUTE_ADMIN_EMAILS = " Admin@Example.com , other@example.com ,, ";

  try {
    assert.equal(hasConfiguredAdminAllowlist(), true);
    assert.equal(isAllowedAdmin("admin@example.com"), true);
    assert.equal(isAllowedAdmin(" OTHER@example.com "), true);
    assert.equal(isAllowedAdmin("blocked@example.com"), false);
  } finally {
    if (previous === undefined) delete process.env.SMARTROUTE_ADMIN_EMAILS;
    else process.env.SMARTROUTE_ADMIN_EMAILS = previous;
  }
});
