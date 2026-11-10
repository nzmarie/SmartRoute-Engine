export function isAllowedAdmin(email: string | null | undefined): boolean {
  if (!email) return false;

  return configuredAdminEmails().includes(email.trim().toLowerCase());
}

export function hasConfiguredAdminAllowlist(): boolean {
  return configuredAdminEmails().length > 0;
}

function configuredAdminEmails(): string[] {
  return (process.env.SMARTROUTE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}
