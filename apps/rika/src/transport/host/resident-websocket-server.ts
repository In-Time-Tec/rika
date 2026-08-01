export const isLegacyResidentPath = (url: string): boolean => url === "/resident/v1"

export const isResidentPath = (url: string): boolean => url === "/resident"

export const protocolUpgradeReason = "Resident protocol upgrade required"
