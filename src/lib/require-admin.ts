import { NextResponse } from "next/server";
import { auth, isGoogleOAuthConfigured } from "@/auth";
import { isAllowedAdmin } from "@/lib/admin-access";

export async function requireAdminApi(): Promise<NextResponse | null> {
  if (!isGoogleOAuthConfigured()) {
    return NextResponse.json(
      { error: "SmartRoute Google authentication is not configured." },
      { status: 503 },
    );
  }

  const session = await auth();
  const email = session?.user?.email;

  if (!email) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  if (!isAllowedAdmin(email)) {
    return NextResponse.json({ error: "Administrator access required." }, { status: 403 });
  }

  return null;
}
