import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { migration001 } from "./thread/product-migration-001-baseline"
import { migration002 } from "./thread/product-migration-002-turns"
import { migration003 } from "./thread/product-migration-003-queued-turn-status"
import { migration004 } from "./execution/product-migration-004-execution-extension-pins"
import { migration005 } from "./thread/product-migration-005-turn-prompt-parts"
import { migration006 } from "./thread/product-migration-006-drop-thread-session-id"
import { migration007 } from "./execution/product-migration-007-execution-route-pins"
import { migration008 } from "./execution/product-migration-008-review-fan-out-owners"
import { migration009 } from "./transcript/product-migration-009-transcript-projection"
import { migration010 } from "./thread/product-migration-010-thread-summaries"
import { migration011 } from "./transcript/product-migration-011-semantic-transcript-projection"
import { migration012 } from "./thread/product-migration-012-queue-state-and-current-transcripts"
import { migration013 } from "./execution/product-migration-013-provider-execution-routes"
import { migration014 } from "./thread/product-migration-014-durable-queue-claims"
import { migration015 } from "./transcript/product-migration-015-usage-cursor-checkpoints"
import { migration016 } from "./transcript/product-migration-016-pricing-version-checkpoints"
import { migration017 } from "./thread/product-migration-017-thread-search-projection"
import { migration018 } from "./thread/product-migration-018-durable-thread-coordination"
import { migration019 } from "./thread/product-migration-019-turn-stop-intent"
import { migration020 } from "./usage/product-migration-020-usage-projection"
import { migration021 } from "./thread/product-migration-021-materialized-thread-summaries"
import { migration022 } from "./transcript/product-migration-022-reconciled-child-trees"
import { migration023 } from "./transcript/product-migration-023-consumed-execution-checkpoints"
import { migration024 } from "./usage/product-migration-024-drop-usage-repairs"
import { migration025 } from "./transcript/product-migration-025-stable-transcript-unit-order"
import { migration026 } from "./thread/product-migration-026-discriminated-turns"
import { migration027 } from "./usage/product-migration-027-usage-projection-sources"
import { productRouteSnapshot } from "./execution/product-migration-028-product-route-snapshot"

export const migrationNames = [
  "product_baseline",
  "turns",
  "queued_turn_status",
  "execution_extension_pins",
  "turn_prompt_parts",
  "drop_thread_session_id",
  "execution_route_pins",
  "review_fan_out_owners",
  "transcript_projection",
  "thread_summaries",
  "semantic_transcript_projection",
  "queue_state_and_current_transcripts",
  "provider_execution_routes",
  "durable_queue_claims",
  "usage_cursor_checkpoints",
  "pricing_version_checkpoints",
  "thread_search_projection",
  "durable_thread_coordination",
  "turn_stop_intent",
  "usage_projection",
  "materialized_thread_summaries",
  "reconciled_child_trees",
  "consumed_execution_checkpoints",
  "drop_usage_repairs",
  "stable_transcript_unit_order",
  "discriminated_turns",
  "usage_projection_sources",
  "product_route_snapshot",
] as const

export const productMigrations = SqliteMigrator.fromRecord({
  "1_product_baseline": migration001,
  "2_turns": migration002,
  "3_queued_turn_status": migration003,
  "4_execution_extension_pins": migration004,
  "5_turn_prompt_parts": migration005,
  "6_drop_thread_session_id": migration006,
  "7_execution_route_pins": migration007,
  "8_review_fan_out_owners": migration008,
  "9_transcript_projection": migration009,
  "10_thread_summaries": migration010,
  "11_semantic_transcript_projection": migration011,
  "12_queue_state_and_current_transcripts": migration012,
  "13_provider_execution_routes": migration013,
  "14_durable_queue_claims": migration014,
  "15_usage_cursor_checkpoints": migration015,
  "16_pricing_version_checkpoints": migration016,
  "17_thread_search_projection": migration017,
  "18_durable_thread_coordination": migration018,
  "19_turn_stop_intent": migration019,
  "20_usage_projection": migration020,
  "21_materialized_thread_summaries": migration021,
  "22_reconciled_child_trees": migration022,
  "23_consumed_execution_checkpoints": migration023,
  "24_drop_usage_repairs": migration024,
  "25_stable_transcript_unit_order": migration025,
  "26_discriminated_turns": migration026,
  "27_usage_projection_sources": migration027,
  "28_product_route_snapshot": productRouteSnapshot,
})
