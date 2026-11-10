import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/require-admin";
import { isNorthShoreSuburb } from "@/lib/north-shore-suburbs";
import { withReadOnlyTransaction } from "@/lib/source-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorizationError = await requireAdminApi();
  if (authorizationError) return authorizationError;

  const suburb = new URL(request.url).searchParams.get("suburb")?.trim() ?? "";
  if (!isNorthShoreSuburb(suburb)) {
    return NextResponse.json({ error: "Choose a valid North Shore suburb." }, { status: 400 });
  }

  try {
    const periods = await withReadOnlyTransaction(async (client) => {
      const result = await client.query<{ year: string | number; quarter: string }>(
        `SELECT year, quarter
         FROM (
           SELECT DISTINCT year, quarter
           FROM outreach_property_quarter_status
           WHERE LOWER(suburb) = LOWER($1)
           UNION
           SELECT DISTINCT year, quarter
           FROM suburb_reports
           WHERE LOWER(suburb) = LOWER($1)
         ) periods
         ORDER BY year DESC, quarter DESC
         LIMIT 20`,
        [suburb],
      );

      return result.rows.map((row) => ({
        year: Number(row.year),
        quarter: row.quarter,
      }));
    });

    return NextResponse.json({ periods });
  } catch (error) {
    console.error("Failed to load Outreach reporting periods.", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Reporting periods could not be loaded from the source database." },
      { status: 503 },
    );
  }
}
