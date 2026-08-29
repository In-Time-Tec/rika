ALTER TABLE rika_hosted_thread_protocol_snapshots
  ADD COLUMN replay_required boolean NOT NULL DEFAULT false;

CREATE TABLE rika_transcript_thread_usage (
  thread_id text PRIMARY KEY REFERENCES rika_threads(id) ON DELETE CASCADE,
  accumulator_json text NOT NULL,
  summary_json text NOT NULL,
  updated_at double precision NOT NULL
);

CREATE TABLE rika_transcript_turn_usage (
  turn_id text PRIMARY KEY REFERENCES rika_turns(id) ON DELETE CASCADE,
  thread_id text NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
  created_at double precision NOT NULL,
  usage_json text NOT NULL,
  has_context boolean NOT NULL,
  context_capacity_json text,
  active_since double precision,
  updated_at double precision NOT NULL
);

CREATE INDEX rika_transcript_turn_usage_thread
  ON rika_transcript_turn_usage (thread_id, created_at DESC, turn_id DESC);
CREATE INDEX rika_transcript_turn_usage_context
  ON rika_transcript_turn_usage (thread_id, created_at DESC, turn_id DESC)
  WHERE has_context;
CREATE INDEX rika_transcript_turn_usage_active
  ON rika_transcript_turn_usage (thread_id, active_since)
  WHERE active_since IS NOT NULL;

WITH projected AS (
  SELECT
    checkpoint.thread_id,
    turn.id AS turn_id,
    turn.created_at,
    turn.execution_route_json::jsonb AS route,
    checkpoint.updated_at,
    checkpoint.state_json::jsonb -> 'usage' AS usage
  FROM rika_transcript_checkpoints checkpoint
  JOIN rika_turns turn ON turn.id = checkpoint.turn_id
  WHERE turn.status <> 'queued' AND checkpoint.projection_version = 6
)
INSERT INTO rika_transcript_turn_usage (
  turn_id,
  thread_id,
  created_at,
  usage_json,
  has_context,
  context_capacity_json,
  active_since,
  updated_at
)
SELECT
  turn_id,
  thread_id,
  created_at,
  usage::text,
  usage ? 'context',
  CASE WHEN usage ? 'context' AND route IS NOT NULL THEN jsonb_build_object(
    'contextWindow', (route -> 'main' -> 'compaction' ->> 'contextWindow')::double precision,
    'reserveTokens', (route -> 'main' -> 'compaction' ->> 'reserveTokens')::double precision
  )::text END,
  (usage -> 'active' ->> 'activeSince')::double precision,
  updated_at
FROM projected;

WITH projected AS (
  SELECT
    thread_id,
    turn_id,
    created_at,
    updated_at,
    usage_json::jsonb AS usage,
    context_capacity_json
  FROM rika_transcript_turn_usage
), aggregated AS (
  SELECT
    thread_id,
    count(*) AS contributions,
    count(*) FILTER (WHERE NOT (usage ->> 'sourceComplete')::boolean) AS incomplete,
    sum(coalesce((usage ->> 'costNanoUsd')::bigint, 0)) AS cost_nano_usd,
    count(*) FILTER (WHERE usage ? 'costNanoUsd') AS cost_count,
    count(*) FILTER (WHERE usage ? 'tokens') AS tokens_count,
    sum(coalesce((usage -> 'tokens' ->> 'total')::bigint, 0)) AS token_total,
    count(*) FILTER (WHERE usage -> 'tokens' ? 'total') AS token_total_count,
    sum(coalesce((usage -> 'tokens' -> 'input' ->> 'total')::bigint, 0)) AS input_total,
    count(*) FILTER (WHERE usage -> 'tokens' -> 'input' ? 'total') AS input_total_count,
    sum(coalesce((usage -> 'tokens' -> 'input' ->> 'uncached')::bigint, 0)) AS input_uncached,
    count(*) FILTER (WHERE usage -> 'tokens' -> 'input' ? 'uncached') AS input_uncached_count,
    sum(coalesce((usage -> 'tokens' -> 'input' ->> 'cacheRead')::bigint, 0)) AS input_cache_read,
    count(*) FILTER (WHERE usage -> 'tokens' -> 'input' ? 'cacheRead') AS input_cache_read_count,
    sum(coalesce((usage -> 'tokens' -> 'input' ->> 'cacheWrite')::bigint, 0)) AS input_cache_write,
    count(*) FILTER (WHERE usage -> 'tokens' -> 'input' ? 'cacheWrite') AS input_cache_write_count,
    sum(coalesce((usage -> 'tokens' -> 'output' ->> 'total')::bigint, 0)) AS output_total,
    count(*) FILTER (WHERE usage -> 'tokens' -> 'output' ? 'total') AS output_total_count,
    sum(coalesce((usage -> 'tokens' -> 'output' ->> 'text')::bigint, 0)) AS output_text,
    count(*) FILTER (WHERE usage -> 'tokens' -> 'output' ? 'text') AS output_text_count,
    sum(coalesce((usage -> 'tokens' -> 'output' ->> 'reasoning')::bigint, 0)) AS output_reasoning,
    count(*) FILTER (WHERE usage -> 'tokens' -> 'output' ? 'reasoning') AS output_reasoning_count,
    sum(coalesce((usage -> 'tokens' ->> 'failedProviderTotal')::bigint, 0)) AS failed_provider_total,
    count(*) FILTER (WHERE usage -> 'tokens' ? 'failedProviderTotal') AS failed_provider_total_count,
    sum((usage ->> 'pricedAttempts')::bigint) AS priced_attempts,
    sum((usage ->> 'unpricedAttempts')::bigint) AS unpriced_attempts,
    sum(coalesce((usage ->> 'includedAttempts')::bigint, 0)) AS included_attempts,
    sum((usage ->> 'countedAttempts')::bigint) AS counted_attempts,
    sum((usage ->> 'uncountedAttempts')::bigint) AS uncounted_attempts,
    count(*) FILTER (WHERE usage -> 'active' ->> '_tag' = 'Available') AS active_available,
    sum(CASE WHEN usage -> 'active' ->> '_tag' = 'Available'
      THEN coalesce((usage -> 'active' ->> 'accumulatedMillis')::double precision, 0) ELSE 0 END) AS active_millis,
    min((usage -> 'active' ->> 'activeSince')::double precision)
      FILTER (WHERE usage -> 'active' ? 'activeSince') AS active_since,
    max(updated_at) AS updated_at
  FROM projected
  GROUP BY thread_id
), latest AS (
  SELECT DISTINCT ON (thread_id)
    thread_id,
    (usage ->> 'contextPending')::boolean AS context_pending
  FROM projected
  ORDER BY thread_id, created_at DESC, turn_id DESC
), contexts AS (
  SELECT DISTINCT ON (thread_id)
    thread_id,
    usage -> 'context' AS context,
    context_capacity_json::jsonb AS capacity
  FROM projected
  WHERE usage ? 'context'
  ORDER BY thread_id, created_at DESC, turn_id DESC
)
INSERT INTO rika_transcript_thread_usage (thread_id, accumulator_json, summary_json, updated_at)
SELECT
  aggregate.thread_id,
  jsonb_build_object(
    'contributions', aggregate.contributions,
    'incomplete', aggregate.incomplete,
    'costNanoUsd', jsonb_build_object('sum', aggregate.cost_nano_usd, 'present', aggregate.cost_count),
    'tokens', aggregate.tokens_count,
    'tokenTotal', jsonb_build_object('sum', aggregate.token_total, 'present', aggregate.token_total_count),
    'inputTotal', jsonb_build_object('sum', aggregate.input_total, 'present', aggregate.input_total_count),
    'inputUncached', jsonb_build_object('sum', aggregate.input_uncached, 'present', aggregate.input_uncached_count),
    'inputCacheRead', jsonb_build_object('sum', aggregate.input_cache_read, 'present', aggregate.input_cache_read_count),
    'inputCacheWrite', jsonb_build_object('sum', aggregate.input_cache_write, 'present', aggregate.input_cache_write_count),
    'outputTotal', jsonb_build_object('sum', aggregate.output_total, 'present', aggregate.output_total_count),
    'outputText', jsonb_build_object('sum', aggregate.output_text, 'present', aggregate.output_text_count),
    'outputReasoning', jsonb_build_object('sum', aggregate.output_reasoning, 'present', aggregate.output_reasoning_count),
    'failedProviderTotal', jsonb_build_object(
      'sum', aggregate.failed_provider_total,
      'present', aggregate.failed_provider_total_count
    ),
    'pricedAttempts', aggregate.priced_attempts,
    'unpricedAttempts', aggregate.unpriced_attempts,
    'includedAttempts', aggregate.included_attempts,
    'countedAttempts', aggregate.counted_attempts,
    'uncountedAttempts', aggregate.uncounted_attempts,
    'activeAvailable', aggregate.active_available,
    'activeAccumulatedMillis', aggregate.active_millis
  )::text,
  jsonb_strip_nulls(jsonb_build_object(
    'usage', jsonb_strip_nulls(jsonb_build_object(
      'costNanoUsd', CASE WHEN aggregate.priced_attempts > 0 AND aggregate.cost_count > 0
        THEN aggregate.cost_nano_usd END,
      'tokens', CASE WHEN aggregate.tokens_count > 0 THEN jsonb_strip_nulls(jsonb_build_object(
        'total', CASE WHEN aggregate.token_total_count > 0 THEN aggregate.token_total END,
        'input', jsonb_strip_nulls(jsonb_build_object(
          'total', CASE WHEN aggregate.input_total_count > 0 THEN aggregate.input_total END,
          'uncached', CASE WHEN aggregate.input_uncached_count > 0 THEN aggregate.input_uncached END,
          'cacheRead', CASE WHEN aggregate.input_cache_read_count > 0 THEN aggregate.input_cache_read END,
          'cacheWrite', CASE WHEN aggregate.input_cache_write_count > 0 THEN aggregate.input_cache_write END
        )),
        'output', jsonb_strip_nulls(jsonb_build_object(
          'total', CASE WHEN aggregate.output_total_count > 0 THEN aggregate.output_total END,
          'text', CASE WHEN aggregate.output_text_count > 0 THEN aggregate.output_text END,
          'reasoning', CASE WHEN aggregate.output_reasoning_count > 0 THEN aggregate.output_reasoning END
        )),
        'failedProviderTotal', CASE WHEN aggregate.failed_provider_total_count > 0
          THEN aggregate.failed_provider_total END
      )) END,
      'pricedAttempts', aggregate.priced_attempts,
      'unpricedAttempts', aggregate.unpriced_attempts,
      'includedAttempts', aggregate.included_attempts,
      'countedAttempts', aggregate.counted_attempts,
      'uncountedAttempts', aggregate.uncounted_attempts,
      'sourceComplete', aggregate.incomplete = 0,
      'context', context.context,
      'contextPending', latest.context_pending,
      'active', CASE WHEN aggregate.active_available > 0 THEN jsonb_strip_nulls(jsonb_build_object(
        '_tag', 'Available',
        'accumulatedMillis', aggregate.active_millis,
        'activeSince', aggregate.active_since
      )) ELSE jsonb_build_object('_tag', 'Unavailable') END
    )),
    'contextCapacity', context.capacity
  ))::text,
  aggregate.updated_at
FROM aggregated aggregate
JOIN latest ON latest.thread_id = aggregate.thread_id
LEFT JOIN contexts context ON context.thread_id = aggregate.thread_id;
