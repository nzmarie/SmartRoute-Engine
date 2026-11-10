export type AddressStatus = "unsent" | "sent" | "junk";

export function resolveAddressStatus(isJunk: boolean, hasSent: boolean): AddressStatus {
  if (isJunk) return "junk";
  if (hasSent) return "sent";
  return "unsent";
}

export function resolveSimulationDisplayStatus(
  status: AddressStatus,
  isDelivered: boolean,
  junkStatusUnknown: boolean,
): AddressStatus {
  if (status === "junk" && junkStatusUnknown) return isDelivered ? "junk" : "unsent";
  if (status === "unsent" && isDelivered) return "sent";
  return status;
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
