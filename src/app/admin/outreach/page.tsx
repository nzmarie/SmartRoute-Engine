import { redirect } from "next/navigation";
import { auth, isGoogleOAuthConfigured } from "@/auth";
import { AdminHeader } from "@/components/admin-header";
import { OutreachWorkspace } from "@/components/outreach-workspace";
import { isAllowedAdmin } from "@/lib/admin-access";
import { NORTH_SHORE_SUBURBS } from "@/lib/north-shore-suburbs";

export const dynamic = "force-dynamic";

export default async function OutreachPage() {
  if (!isGoogleOAuthConfigured()) redirect("/admin/login");
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !isAllowedAdmin(email)) redirect("/admin/login");

  return (
    <>
      <AdminHeader email={email} section="Outreach" />
      <main className="outreach-page">
        <div className="page-heading outreach-heading">
          <div>
            <p className="eyebrow">ADMIN WORKSPACE</p>
            <h1>Outreach</h1>
            <p className="muted">Select a North Shore suburb to view its dispatch addresses.</p>
          </div>
        </div>
        <OutreachWorkspace suburbs={NORTH_SHORE_SUBURBS} />
      </main>
    </>
  );
}
