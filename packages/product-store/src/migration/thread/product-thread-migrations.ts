import { migration001 } from "./product-migration-001-baseline"
import { migration002 } from "./product-migration-002-turns"
import { migration003 } from "./product-migration-003-queued-turn-status"
import { migration005 } from "./product-migration-005-turn-prompt-parts"
import { migration006 } from "./product-migration-006-drop-thread-session-id"
import { migration010 } from "./product-migration-010-thread-summaries"
import { migration012 } from "./product-migration-012-queue-state-and-current-transcripts"
import { migration014 } from "./product-migration-014-durable-queue-claims"
import { migration017 } from "./product-migration-017-thread-search-projection"
import { migration018 } from "./product-migration-018-durable-thread-coordination"
import { migration019 } from "./product-migration-019-turn-stop-intent"
import { migration021 } from "./product-migration-021-materialized-thread-summaries"
import { migration026 } from "./product-migration-026-discriminated-turns"

export const threadMigrations: Record<number, any> = {
  1: migration001,
  2: migration002,
  3: migration003,
  5: migration005,
  6: migration006,
  10: migration010,
  12: migration012,
  14: migration014,
  17: migration017,
  18: migration018,
  19: migration019,
  21: migration021,
  26: migration026,
} as const
