import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { hasConfiguredAdminAllowlist, isAllowedAdmin } from "@/lib/admin-access";

function getAuthUrl(): string | null {
  const configuredUrl = process.env.SMARTROUTE_AUTH_URL?.trim();
  if (!configuredUrl) return null;

  const url = new URL(configuredUrl);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("SMARTROUTE_AUTH_URL must be an HTTPS origin (or localhost during development).");
  }

  return url.origin;
}

const authUrl = getAuthUrl();
if (authUrl) process.env.AUTH_URL = authUrl;

const googleClientId =
  process.env.SMARTROUTE_GOOGLE_CLIENT_ID?.trim() || process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret =
  process.env.SMARTROUTE_GOOGLE_CLIENT_SECRET?.trim() || process.env.GOOGLE_CLIENT_SECRET?.trim();
const googleConfigured = Boolean(googleClientId && googleClientSecret);

export const isGoogleOAuthConfigured = () =>
  googleConfigured &&
  Boolean(process.env.SMARTROUTE_AUTH_SECRET?.trim()) &&
  Boolean(authUrl) &&
  hasConfiguredAdminAllowlist();

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.SMARTROUTE_AUTH_SECRET,
  trustHost: Boolean(authUrl),
  providers:
    googleConfigured && googleClientId && googleClientSecret
      ? [Google({ clientId: googleClientId, clientSecret: googleClientSecret })]
      : [],
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: "/admin/login" },
  callbacks: {
    async signIn({ user, profile }) {
      return (
        isGoogleOAuthConfigured() &&
        profile?.email_verified === true &&
        isAllowedAdmin(user.email)
      );
    },
  },
});
