import { migration009 } from "./product-migration-009-transcript-projection"
import { migration011 } from "./product-migration-011-semantic-transcript-projection"
import { migration015 } from "./product-migration-015-usage-cursor-checkpoints"
import { migration016 } from "./product-migration-016-pricing-version-checkpoints"
import { migration022 } from "./product-migration-022-reconciled-child-trees"
import { migration023 } from "./product-migration-023-consumed-execution-checkpoints"
import { migration025 } from "./product-migration-025-stable-transcript-unit-order"

export const transcriptMigrations: Record<number, any> = {
  9: migration009,
  11: migration011,
  15: migration015,
  16: migration016,
  22: migration022,
  23: migration023,
  25: migration025,
} as const
