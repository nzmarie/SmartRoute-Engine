export type AddressStatus = "unsent" | "sent" | "junk";

export function resolveAddressStatus(isJunk: boolean, hasSent: boolean): AddressStatus {
  if (isJunk) return "junk";
  if (hasSent) return "sent";
  return "unsent";
}

export const ADDRESS_STATUS_LABELS: Record<AddressStatus, string> = {
  unsent: "Unsent",
  sent: "Sent",
  junk: "Junk mail",
};

export const ADDRESS_STATUS_COLORS: Record<AddressStatus, string> = {
  unsent: "#dc2626",
  sent: "#7c3aed",
  junk: "#eab308",
};
