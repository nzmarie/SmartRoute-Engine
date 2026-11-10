import { auth, isGoogleOAuthConfigured, signIn } from "@/auth";
import { isAllowedAdmin } from "@/lib/admin-access";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const oauthConfigured = isGoogleOAuthConfigured();
  if (oauthConfigured) {
    const session = await auth();
    if (session?.user?.email && isAllowedAdmin(session.user.email)) {
      redirect("/admin/dashboard");
    }
  }

  const { error } = await searchParams;

  async function signInWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/admin/dashboard" });
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">SR</div>
        <p className="eyebrow">SMARTROUTE ENGINE</p>
        <h1>Admin sign in</h1>
        <p className="muted">
          Use an approved Google account to access Outreach.
        </p>
        {error ? (
          <p className="notice notice-error" role="alert">
            Google sign-in was not accepted. Confirm that your account is on the SmartRoute
            administrator allowlist.
          </p>
        ) : null}
        {oauthConfigured ? (
          <form action={signInWithGoogle}>
            <button className="google-sign-in" type="submit">
              <span aria-hidden="true">G</span>
              Sign in with Google
            </button>
          </form>
        ) : (
          <p className="notice notice-warning" role="status">
            Google sign-in is not configured. Set the SmartRoute OAuth client, auth secret,
            base URL, and administrator allowlist in the local environment.
          </p>
        )}
        <p className="login-footnote">Access is restricted to explicitly allowlisted accounts.</p>
      </section>
    </main>
  );
}
