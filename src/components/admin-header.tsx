import Link from "next/link";
import { signOut } from "@/auth";

interface AdminHeaderProps {
  email: string;
  section: "Dashboard" | "Outreach";
}

export function AdminHeader({ email, section }: AdminHeaderProps) {
  async function logout() {
    "use server";
    await signOut({ redirectTo: "/admin/login" });
  }

  return (
    <header className="admin-header">
      <Link className="brand-lockup" href="/admin/dashboard">
        <span className="brand-mark brand-mark-small">SR</span>
        <span>SmartRoute</span>
      </Link>
      <nav className="admin-nav" aria-label="Admin">
        <Link
          aria-current={section === "Dashboard" ? "page" : undefined}
          className={section === "Dashboard" ? "nav-link active" : "nav-link"}
          href="/admin/dashboard"
        >
          Dashboard
        </Link>
        <Link
          aria-current={section === "Outreach" ? "page" : undefined}
          className={section === "Outreach" ? "nav-link active" : "nav-link"}
          href="/admin/outreach"
        >
          Outreach
        </Link>
      </nav>
      <div className="account-actions">
        <span className="account-email">{email}</span>
        <form action={logout}>
          <button className="sign-out-button" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
