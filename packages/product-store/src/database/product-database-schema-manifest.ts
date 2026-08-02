const migrationTableObjects = ["table:rika_migrations"]
const baselineObjects = [
  ...migrationTableObjects,
  "table:rika_workspaces",
  "table:rika_threads",
  "index:rika_threads_listing",
]
const turnObjects = [...baselineObjects, "table:rika_turns", "index:rika_turns_thread"]
const transcriptObjects = [...turnObjects, "table:rika_transcript_entries", "index:rika_transcript_page"]
const summaryObjects = [
  ...transcriptObjects,
  "table:rika_thread_turn_activity",
  "index:rika_thread_turn_activity_summary",
  "table:rika_thread_read_state",
]
const semanticTranscriptObjects = [
  ...summaryObjects,
  "table:rika_transcript_checkpoints",
  "table:rika_transcript_units",
  "index:rika_transcript_units_page",
  "index:rika_transcript_units_turn",
]
const queueObjects = [...semanticTranscriptObjects, "index:rika_turns_queue", "table:rika_thread_queue_state"]
const currentObjects = [...queueObjects, "index:rika_turns_queue_claim"]
const searchObjects = [
  ...currentObjects,
  "table:rika_thread_search",
  "table:rika_thread_search_data",
  "table:rika_thread_search_idx",
  "table:rika_thread_search_content",
  "table:rika_thread_search_docsize",
  "table:rika_thread_search_config",
  "table:rika_thread_search_files",
  "index:rika_thread_search_files_path",
]
const coordinationObjects = [
  ...searchObjects,
  "table:rika_thread_relationships",
  "index:rika_thread_relationship_identity",
  "table:rika_thread_invocation_receipts",
  "index:rika_thread_invocation_source_root",
  "table:rika_thread_result_routes",
  "index:rika_thread_result_ready",
  "table:rika_thread_root_readiness",
]
const usageObjects = [
  ...coordinationObjects,
  "table:rika_turn_usage",
  "index:rika_turn_usage_thread",
  "table:rika_usage_repairs",
]
const materializedSummaryObjects = [
  ...usageObjects,
  "index:rika_turns_thread_updated",
  "index:rika_turns_thread_nonqueued",
  "table:rika_thread_picker_summary",
  "index:rika_thread_picker_summary_listing",
  "trigger:rika_thread_picker_summary_thread_insert",
  "trigger:rika_thread_picker_summary_thread_update",
  "trigger:rika_thread_picker_summary_turn_insert",
  "trigger:rika_thread_picker_summary_turn_update",
  "trigger:rika_thread_picker_summary_turn_before_delete",
  "trigger:rika_thread_picker_summary_turn_delete",
  "trigger:rika_thread_picker_summary_activity_insert",
  "trigger:rika_thread_picker_summary_activity_update",
  "trigger:rika_thread_picker_summary_activity_delete",
]
const droppedUsageRepairObjects = materializedSummaryObjects.filter((object) => object !== "table:rika_usage_repairs")
const stableTranscriptObjects = [
  ...droppedUsageRepairObjects.filter(
    (object) =>
      object !== "table:rika_transcript_entries" &&
      object !== "index:rika_transcript_page" &&
      object !== "table:rika_thread_root_readiness",
  ),
  "table:rika_transcript_execution_checkpoints",
  "table:rika_thread_root_results",
]

export const schemaObjectsByMigration: ReadonlyArray<ReadonlyArray<string>> = [
  migrationTableObjects,
  baselineObjects,
  turnObjects,
  turnObjects,
  turnObjects,
  turnObjects,
  turnObjects,
  turnObjects,
  turnObjects,
  transcriptObjects,
  summaryObjects,
  semanticTranscriptObjects,
  queueObjects,
  queueObjects,
  currentObjects,
  currentObjects,
  currentObjects,
  searchObjects,
  coordinationObjects,
  coordinationObjects,
  usageObjects,
  materializedSummaryObjects,
  materializedSummaryObjects,
  materializedSummaryObjects,
  droppedUsageRepairObjects,
  stableTranscriptObjects,
  stableTranscriptObjects,
  stableTranscriptObjects,
  stableTranscriptObjects,
  stableTranscriptObjects,
]
