import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/require-admin";
import { isNorthShoreSuburb } from "@/lib/north-shore-suburbs";
import { loadMapAddresses, MapDataTooLargeError } from "@/lib/map-data";
import { withReadOnlyTransaction } from "@/lib/source-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorizationError = await requireAdminApi();
  if (authorizationError) return authorizationError;

  const searchParams = new URL(request.url).searchParams;
  const suburb = searchParams.get("suburb")?.trim() ?? "";
  const rawYear = searchParams.get("year");
  const quarter = searchParams.get("quarter")?.trim() ?? null;

  if (!isNorthShoreSuburb(suburb)) {
    return NextResponse.json({ error: "Choose a valid North Shore suburb." }, { status: 400 });
  }

  let year: number | null = null;
  if (rawYear !== null) {
    year = Number(rawYear);
    if (!Number.isInteger(year) || year < 2000 || year > 2200) {
      return NextResponse.json({ error: "Choose a valid reporting year." }, { status: 400 });
    }
  }

  if ((year === null) !== (quarter === null)) {
    return NextResponse.json(
      { error: "Reporting year and quarter must be selected together." },
      { status: 400 },
    );
  }

  if (quarter !== null && !/^Q[1-4]$/i.test(quarter)) {
    return NextResponse.json({ error: "Choose a valid reporting quarter." }, { status: 400 });
  }

  try {
    const data = await withReadOnlyTransaction((client) =>
      loadMapAddresses(client, suburb, year, quarter?.toUpperCase() ?? null),
    );
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof MapDataTooLargeError) {
      return NextResponse.json(
        { error: "This suburb exceeds the 5,000-address map limit. Select a reporting quarter." },
        { status: 413 },
      );
    }

    console.error("Failed to load Outreach map data.", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Map data could not be loaded from the source database." },
      { status: 503 },
    );
  }
}
