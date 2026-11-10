import { resolveAddressStatus, type AddressStatus } from "./address-status";

export interface MapAddressRow {
  address_key: string;
  address: string;
  street: string | null;
  house_number: number | string | null;
  latitude: number | null;
  longitude: number | null;
  is_junk: boolean;
  has_sent: boolean;
}

export interface MapAddressPoint {
  addressKey: string;
  address: string;
  street: string | null;
  houseNumber: number | null;
  lat: number;
  lng: number;
  status: AddressStatus;
}

export interface MapAddressSummary {
  total: number;
  mapped: number;
  missingCoordinates: number;
  states: Record<AddressStatus, number>;
}

export function processMapAddressRows(rows: MapAddressRow[]) {
  const points: MapAddressPoint[] = [];
  const states: Record<AddressStatus, number> = {
    unsent: 0,
    sent: 0,
    junk: 0,
  };
  let missingCoordinates = 0;

  for (const row of rows) {
    const status = resolveAddressStatus(row.is_junk, row.has_sent);
    states[status] += 1;

    const { latitude: lat, longitude: lng } = row;
    if (
      lat === null ||
      lng === null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      missingCoordinates += 1;
      continue;
    }

    const parsedHouseNumber =
      row.house_number === null || String(row.house_number).trim() === ""
        ? Number.NaN
        : Number(row.house_number);
    const houseNumber = Number.isSafeInteger(parsedHouseNumber) ? parsedHouseNumber : null;
    points.push({
      addressKey: row.address_key,
      address: row.address,
      street: row.street,
      houseNumber,
      lat,
      lng,
      status,
    });
  }

  return {
    points,
    summary: {
      total: rows.length,
      mapped: points.length,
      missingCoordinates,
      states,
    },
  };
}
