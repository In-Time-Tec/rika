import { migration020 } from "./product-migration-020-usage-projection"
import { migration024 } from "./product-migration-024-drop-usage-repairs"
import { migration027 } from "./product-migration-027-usage-projection-sources"

export const usageMigrations: Record<number, any> = {
  20: migration020,
  24: migration024,
  27: migration027,
} as const
