import "server-only";
import type { PoolClient } from "pg";
import {
  processMapAddressRows,
  type MapAddressRow,
  type MapAddressPoint,
  type MapAddressSummary,
} from "@/lib/map-address-results";

export type { MapAddressPoint, MapAddressSummary } from "@/lib/map-address-results";

const MAX_MAP_ADDRESSES = 5_000;

const MAP_ROWS_CTE = `
  WITH quarter_state AS (
    SELECT
      q.outreach_property_id,
      BOOL_OR(
        CASE
          WHEN $2::BIGINT IS NOT NULL THEN COALESCE(q.is_junk, FALSE)
          ELSE FALSE
        END
      ) AS quarter_junk,
      BOOL_OR(q.status IN ('sent', 'partial') OR COALESCE(q.sent_count, 0) > 0) AS quarter_sent
    FROM outreach_property_quarter_status q
    WHERE LOWER(q.suburb) = LOWER($1)
      AND ($2::BIGINT IS NULL OR q.year = $2::BIGINT)
      AND ($3::TEXT IS NULL OR q.quarter = $3::TEXT)
    GROUP BY q.outreach_property_id
  ),
  send_state AS (
    SELECT s.outreach_property_id, TRUE AS has_send_log
    FROM outreach_send_logs s
    WHERE LOWER(s.suburb) = LOWER($1)
      AND (
        $2::BIGINT IS NULL
        OR EXISTS (
          SELECT 1
          FROM suburb_reports r
          WHERE r.id = s.suburb_report_id
            AND LOWER(r.suburb) = LOWER($1)
            AND r.year = $2::BIGINT
            AND r.quarter = $3::TEXT
        )
      )
    GROUP BY s.outreach_property_id
  ),
  source_rows AS (
    SELECT
      COALESCE(
        REPLACE(op.property_id::TEXT, '-', ''),
        LOWER(TRIM(op.property_address))
      ) AS address_key,
      op.property_address AS address,
      op.street,
      op.house_number,
      COALESCE(p.latitude, fallback.latitude) AS latitude,
      COALESCE(p.longitude, fallback.longitude) AS longitude,
      (
        COALESCE(p.no_junk_mail, fallback.no_junk_mail, FALSE)
        OR COALESCE(qs.quarter_junk, FALSE)
      ) AS is_junk,
      (
        COALESCE(qs.quarter_sent, FALSE)
        OR COALESCE(ss.has_send_log, FALSE)
      ) AS has_sent
    FROM outreach_properties op
    LEFT JOIN properties p
      ON op.property_id IS NOT NULL
      AND REPLACE(op.property_id::TEXT, '-', '') = p.id
    LEFT JOIN LATERAL (
      SELECT p2.latitude, p2.longitude, p2.no_junk_mail
      FROM properties p2
      WHERE p.id IS NULL
        AND LOWER(TRIM(p2.address)) = LOWER(TRIM(op.property_address))
        AND LOWER(TRIM(p2.suburb)) = LOWER(TRIM(op.suburb))
      LIMIT 1
    ) fallback ON TRUE
    LEFT JOIN quarter_state qs ON qs.outreach_property_id = op.id
    LEFT JOIN send_state ss ON ss.outreach_property_id = op.id
    WHERE LOWER(op.suburb) = LOWER($1)
      AND (
        $2::BIGINT IS NULL
        OR (
          EXISTS (
            SELECT 1
            FROM suburb_reports r
            WHERE LOWER(r.suburb) = LOWER($1)
              AND r.year = $2::BIGINT
              AND r.quarter = $3::TEXT
          )
        )
      )
  ),
  deduplicated AS (
    SELECT
      address_key,
      MAX(address) AS address,
      MAX(street) AS street,
      MAX(house_number) AS house_number,
      MAX(latitude) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL) AS latitude,
      MAX(longitude) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL) AS longitude,
      BOOL_OR(is_junk) AS is_junk,
      BOOL_OR(has_sent) AS has_sent
    FROM source_rows
    GROUP BY address_key
  )
`;

export class MapDataTooLargeError extends Error {
  constructor() {
    super(`This suburb has more than ${MAX_MAP_ADDRESSES} source addresses.`);
    this.name = "MapDataTooLargeError";
  }
}

export async function loadMapAddresses(
  client: PoolClient,
  suburb: string,
  year: number | null,
  quarter: string | null,
): Promise<{ points: MapAddressPoint[]; summary: MapAddressSummary }> {
  const parameters = [suburb, year, quarter];
  const result = await client.query<MapAddressRow>(
    `${MAP_ROWS_CTE}
      SELECT address_key, address, street, house_number, latitude, longitude, is_junk, has_sent
      FROM deduplicated
      ORDER BY address_key
      LIMIT $4`,
    [...parameters, MAX_MAP_ADDRESSES + 1],
  );

  if (result.rows.length > MAX_MAP_ADDRESSES) {
    throw new MapDataTooLargeError();
  }

  return processMapAddressRows(result.rows);
}
