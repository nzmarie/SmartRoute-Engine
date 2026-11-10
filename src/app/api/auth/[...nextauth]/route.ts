import { handlers, isGoogleOAuthConfigured } from "@/auth";
import { NextRequest, NextResponse } from "next/server";

function configurationResponse() {
  return NextResponse.json(
    { error: "SmartRoute Google authentication is not configured." },
    { status: 503 },
  );
}

export async function GET(request: NextRequest) {
  if (!isGoogleOAuthConfigured()) return configurationResponse();
  return handlers.GET(request);
}

export async function POST(request: NextRequest) {
  if (!isGoogleOAuthConfigured()) return configurationResponse();
  return handlers.POST(request);
}
