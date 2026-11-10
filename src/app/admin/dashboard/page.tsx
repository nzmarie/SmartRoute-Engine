import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, isGoogleOAuthConfigured } from "@/auth";
import { AdminHeader } from "@/components/admin-header";
import { isAllowedAdmin } from "@/lib/admin-access";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  if (!isGoogleOAuthConfigured()) redirect("/admin/login");
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !isAllowedAdmin(email)) redirect("/admin/login");

  return (
    <>
      <AdminHeader email={email} section="Dashboard" />
      <main className="dashboard-shell">
        <div className="page-heading">
          <p className="eyebrow">ADMIN</p>
          <h1>Dashboard</h1>
          <p className="muted">Choose an admin workspace to continue.</p>
        </div>
        <Link className="workspace-card" href="/admin/outreach">
          <div className="workspace-icon" aria-hidden="true">
            ↗
          </div>
          <div>
            <h2>Outreach</h2>
            <p className="muted">Browse North Shore addresses on Google Maps.</p>
          </div>
          <span className="workspace-arrow" aria-hidden="true">
            →
          </span>
        </Link>
      </main>
    </>
  );
}
