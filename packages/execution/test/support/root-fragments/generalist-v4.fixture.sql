-- Generated from released Generalist 0.46.1 (schema 4) with real Runtime/model execution.
-- Synthetic completed, admitted, and interrupted Runs; the interrupted Run has a durable model checkpoint.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'SQL_ASCII';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
SET default_tablespace = '';
SET default_table_access_method = heap;
CREATE TABLE public.generalist_agent_names (
    scope text NOT NULL,
    name text NOT NULL,
    run_id text NOT NULL
);
CREATE TABLE public.generalist_executable_registrations (
    pin text NOT NULL,
    codec text NOT NULL,
    version text NOT NULL,
    payload_json text NOT NULL,
    registration_digest text NOT NULL
);
CREATE TABLE public.generalist_external_child_placements (
    placement_id text NOT NULL,
    parent_run_id text NOT NULL,
    partition text NOT NULL,
    external_run_id text NOT NULL,
    invocation_id text NOT NULL,
    request_digest text NOT NULL,
    executable_digest text NOT NULL,
    wait_id text,
    suspension_identity text,
    acknowledged boolean DEFAULT false NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    settlement_id text,
    outcome_json text,
    outcome_event_id text,
    created_at timestamp with time zone NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT generalist_external_child_placements_check CHECK ((((settlement_id IS NULL) AND (outcome_json IS NULL) AND (outcome_event_id IS NULL) AND (settled_at IS NULL)) OR ((settlement_id IS NOT NULL) AND (outcome_json IS NOT NULL) AND (outcome_event_id IS NOT NULL) AND (settled_at IS NOT NULL))))
);
CREATE TABLE public.generalist_external_roots (
    placement_id text NOT NULL,
    parent_partition text NOT NULL,
    parent_run_id text NOT NULL,
    partition text NOT NULL,
    run_id text NOT NULL,
    session_id text NOT NULL,
    request_digest text NOT NULL,
    executable_digest text NOT NULL,
    admission_digest text NOT NULL,
    activated boolean DEFAULT false NOT NULL,
    settlement_acknowledged boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL
);
CREATE TABLE public.generalist_fan_out_members (
    fan_out_id text NOT NULL,
    ordinal integer NOT NULL,
    member_key text NOT NULL,
    selection text NOT NULL,
    display_label text,
    prompt_json text NOT NULL,
    origin_json text,
    child_run_id text NOT NULL,
    depth integer NOT NULL,
    status text NOT NULL,
    terminal_event_id text,
    outcome_json text
);
CREATE TABLE public.generalist_fan_outs (
    fan_out_id text NOT NULL,
    parent_run_id text NOT NULL,
    idempotency_key text NOT NULL,
    input_digest text NOT NULL,
    join_json text NOT NULL,
    remainder text NOT NULL,
    concurrency integer NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
CREATE TABLE public.generalist_lanes (
    session_id text NOT NULL,
    accepted_sequence bigint NOT NULL,
    queue_json text NOT NULL,
    head_run_id text
);
CREATE TABLE public.generalist_messages (
    entry_id text NOT NULL,
    target_session_id text NOT NULL,
    sequence bigint NOT NULL,
    from_address text NOT NULL,
    from_run_id text NOT NULL,
    to_address text NOT NULL,
    message_id text NOT NULL,
    idempotency_key text NOT NULL,
    digest text NOT NULL,
    bytes bigint NOT NULL,
    admitted_at_millis bigint NOT NULL,
    prompt_json text NOT NULL,
    correlation_id text NOT NULL,
    causation_id text,
    in_reply_to text,
    metadata_json text NOT NULL,
    delivered_run_id text,
    steering_entry_id text
);
CREATE TABLE public.generalist_program_operations (
    run_id text NOT NULL,
    operation_name text NOT NULL,
    kind text NOT NULL,
    capability text NOT NULL,
    input_digest text NOT NULL,
    input_json text NOT NULL,
    replay_policy text NOT NULL,
    status text NOT NULL,
    result_json text,
    error_json text,
    wait_id text,
    fan_out_id text,
    child_run_ids_json text NOT NULL,
    resolution_idempotency_key text,
    resolution_json text
);
CREATE TABLE public.generalist_program_runs (
    run_id text NOT NULL,
    program_pin text NOT NULL,
    budget_json text NOT NULL,
    deadline_millis bigint NOT NULL,
    tool_calls bigint DEFAULT 0 NOT NULL,
    agent_runs bigint DEFAULT 0 NOT NULL,
    tokens bigint DEFAULT 0 NOT NULL,
    log_bytes bigint DEFAULT 0 NOT NULL,
    active_slots bigint DEFAULT 0 NOT NULL
);
CREATE TABLE public.generalist_run_acknowledgements (
    run_id text NOT NULL,
    sequence integer NOT NULL,
    acknowledged_at timestamp with time zone NOT NULL
);
CREATE TABLE public.generalist_run_events (
    run_id text NOT NULL,
    sequence integer NOT NULL,
    event_id text NOT NULL,
    event_json text NOT NULL
);
CREATE TABLE public.generalist_run_links (
    parent_run_id text NOT NULL,
    child_run_id text NOT NULL,
    invocation_id text NOT NULL,
    readiness text NOT NULL,
    terminal_event_id text,
    created_at timestamp with time zone NOT NULL,
    settled_at timestamp with time zone
);
CREATE TABLE public.generalist_run_operations (
    run_id text NOT NULL,
    operation_id text NOT NULL,
    operation_key text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    input_digest text NOT NULL,
    input_json text NOT NULL,
    result_json text,
    error_json text,
    replay_policy text NOT NULL,
    attempt integer NOT NULL,
    owner_worker_id text,
    lease_expires_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    resolution_idempotency_key text,
    resolution_json text
);
CREATE TABLE public.generalist_run_registrations (
    run_id text NOT NULL,
    pin text NOT NULL
);
CREATE TABLE public.generalist_run_steering (
    entry_id text NOT NULL,
    run_id text NOT NULL,
    sequence bigint NOT NULL,
    idempotency_key text NOT NULL,
    digest text NOT NULL,
    prompt_json text NOT NULL,
    consumed_operation_id text,
    discarded_reason text
);
CREATE TABLE public.generalist_run_waits (
    run_id text NOT NULL,
    wait_id text NOT NULL,
    authored_order integer NOT NULL,
    reason text NOT NULL,
    status text NOT NULL,
    response_json text,
    due_at timestamp with time zone,
    owner_worker_id text,
    lease_expires_at timestamp with time zone,
    opened_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone
);
CREATE TABLE public.generalist_runs (
    run_id text NOT NULL,
    status text NOT NULL,
    address text NOT NULL,
    session_id text NOT NULL,
    message_id text NOT NULL,
    message_json text NOT NULL,
    message_digest text NOT NULL,
    idempotency_key text NOT NULL,
    executable_ref_json text NOT NULL,
    executable_manifest_json text NOT NULL,
    root_run_id text NOT NULL,
    depth integer NOT NULL,
    max_depth integer NOT NULL,
    max_subagents integer NOT NULL,
    parent_run_id text,
    invocation_id text,
    attempt integer DEFAULT 0 NOT NULL,
    attempt_fence integer DEFAULT 0 NOT NULL,
    last_sequence integer DEFAULT '-1'::integer NOT NULL,
    last_turn_completed_sequence integer DEFAULT '-1'::integer NOT NULL,
    cancellation_requested boolean DEFAULT false NOT NULL,
    cancel_reason text,
    terminal_event_id text,
    accepted_sequence bigint NOT NULL,
    driver_checkpoint_json text,
    suspension_json text,
    continuation_json text,
    pending_outcome_json text,
    owner_worker_id text,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
CREATE TABLE public.generalist_schema_meta (
    id integer NOT NULL,
    version integer NOT NULL,
    checksum text NOT NULL,
    dirty boolean DEFAULT false NOT NULL,
    applied_at timestamp with time zone NOT NULL,
    CONSTRAINT generalist_schema_meta_id_check CHECK ((id = 1))
);
CREATE TABLE public.generalist_session_entries (
    session_id text NOT NULL,
    entry_id text NOT NULL,
    parent_id text,
    seq bigint NOT NULL,
    tag text NOT NULL,
    payload_json text NOT NULL,
    created_at timestamp with time zone NOT NULL
);
CREATE TABLE public.generalist_sessions (
    session_id text NOT NULL,
    leaf_id text,
    next_seq bigint DEFAULT 0 NOT NULL,
    writer_epoch bigint DEFAULT 0 NOT NULL,
    writer_run_id text,
    writer_owner_id text,
    writer_attempt_fence integer,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT generalist_sessions_check CHECK ((((writer_run_id IS NULL) AND (writer_owner_id IS NULL) AND (writer_attempt_fence IS NULL)) OR ((writer_run_id IS NOT NULL) AND (writer_owner_id IS NOT NULL) AND (writer_attempt_fence IS NOT NULL))))
);
CREATE TABLE public.generalist_sql_migrations (
    migration_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text NOT NULL
);
CREATE TABLE public.generalist_tree_event_index (
    root_run_id text NOT NULL,
    "position" bigint NOT NULL,
    run_id text NOT NULL,
    run_sequence integer NOT NULL,
    event_id text NOT NULL
);
CREATE TABLE public.generalist_tree_roots (
    root_run_id text NOT NULL,
    earliest_position bigint DEFAULT 0 NOT NULL,
    last_position bigint DEFAULT '-1'::integer NOT NULL
);
INSERT INTO public.generalist_executable_registrations VALUES ('capability-pin:v1:sha256:dd986e4275d8557e4c67c5ac5abc4a274388062cba29f1a24a832cbb4a24928e', 'upgrade-fixture', '1', '{"pin":"capability-pin:v1:sha256:dd986e4275d8557e4c67c5ac5abc4a274388062cba29f1a24a832cbb4a24928e","codec":"upgrade-fixture","version":"1","payload":{}}', '586d2b362326b0f5a12519780846af5b20221d85dddd7ce9dde3e3f193d31ed4');
INSERT INTO public.generalist_executable_registrations VALUES ('model-pin:v1:sha256:8b9320cf56b68efc2732b4c8161df968a12092457a3ef52a04f6cdd8b6017b2c', 'upgrade-fixture', '1', '{"pin":"model-pin:v1:sha256:8b9320cf56b68efc2732b4c8161df968a12092457a3ef52a04f6cdd8b6017b2c","codec":"upgrade-fixture","version":"1","payload":{}}', 'f091116eb42e1fe38003bf6e68d49a25c55361716c1d7569cc3ecf016b63ac42');
INSERT INTO public.generalist_executable_registrations VALUES ('capability-pin:v1:sha256:0fbb160d488f8a11895b7905f75990c787f73f475b1c0a3a9a8089d7c97d97bf', 'upgrade-fixture', '1', '{"pin":"capability-pin:v1:sha256:0fbb160d488f8a11895b7905f75990c787f73f475b1c0a3a9a8089d7c97d97bf","codec":"upgrade-fixture","version":"1","payload":{}}', '4442eb6136b3a070a43ace3102be120e002731c81e4bd7a0568f33bb6c282e1b');
INSERT INTO public.generalist_executable_registrations VALUES ('model-pin:v1:sha256:4306c3a05abe06f6483520cb224ea772d090c4f39bb8f5705ef6c8c0b5cdbc04', 'upgrade-fixture', '1', '{"pin":"model-pin:v1:sha256:4306c3a05abe06f6483520cb224ea772d090c4f39bb8f5705ef6c8c0b5cdbc04","codec":"upgrade-fixture","version":"1","payload":{}}', 'f2be6d921db1ecf18515738b62c31459cb742b0c2524786a6ae87ce978476fdf');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 0, 'run_mtorvpnj_1w9jn4l8qct:0', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:0","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":0,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.297Z","_tag":"RunAccepted","messageId":"start:completed","address":"runtime:start"}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 1, 'run_mtorvpnj_1w9jn4l8qct:1', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:1","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":1,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"attemptId":"run_mtorvpnj_1w9jn4l8qct:attempt:1","rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.300Z","_tag":"RunAttemptStarted","attempt":1}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 2, 'run_mtorvpnj_1w9jn4l8qct:2', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:2","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":2,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"attemptId":"run_mtorvpnj_1w9jn4l8qct:attempt:1","rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.327Z","_tag":"TurnStarted","turn":0}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 3, 'run_mtorvpnj_1w9jn4l8qct:3', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:3","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":3,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"attemptId":"run_mtorvpnj_1w9jn4l8qct:attempt:1","rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.346Z","_tag":"ModelCallStarted","deliveryId":"id_CVqeu75hLaMP5WoE:0","turn":0,"modelCallId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation","purpose":"conversation","startedAt":1788636315343}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 4, 'run_mtorvpnj_1w9jn4l8qct:4', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:4","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":4,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"attemptId":"run_mtorvpnj_1w9jn4l8qct:attempt:1","rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.348Z","_tag":"ModelAttemptStarted","deliveryId":"id_CVqeu75hLaMP5WoE:1","turn":0,"modelCallId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation","modelAttemptId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation:attempt:0","attempt":0,"startedAt":1788636315343}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 5, 'run_mtorvpnj_1w9jn4l8qct:5', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:5","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":5,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"attemptId":"run_mtorvpnj_1w9jn4l8qct:attempt:1","rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.350Z","_tag":"ModelAttemptFirstOutput","deliveryId":"id_CVqeu75hLaMP5WoE:2","turn":0,"modelCallId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation","modelAttemptId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation:attempt:0","attempt":0,"kind":"text","at":1788636315345}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 6, 'run_mtorvpnj_1w9jn4l8qct:6', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:6","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":6,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"attemptId":"run_mtorvpnj_1w9jn4l8qct:attempt:1","rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.357Z","_tag":"ModelResponseCommitted","turn":0,"operationKey":"run_mtorvpnj_1w9jn4l8qct:model:0:0:conversation","modelCallId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation","modelAttemptId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation:attempt:0","attempt":0,"sessionId":"completed-session","sessionParentId":"run_mtorvpnj_1w9jn4l8qct:model:0:session-entry:root:0:user","sessionEntryId":"run_mtorvpnj_1w9jn4l8qct:model-response-committed:run_mtorvpnj_1w9jn4l8qct:model:0:0:conversation","budgetCharge":0,"digest":"624e9a9033c5f79ee7f3c146c3ec45290079e7715d430855e9be00b033927b62","usage":{"inputTokens":{},"outputTokens":{}},"finishReason":"stop"}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 7, 'run_mtorvpnj_1w9jn4l8qct:7', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:7","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":7,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"attemptId":"run_mtorvpnj_1w9jn4l8qct:attempt:1","rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.360Z","_tag":"ModelAttemptCompleted","deliveryId":"id_CVqeu75hLaMP5WoE:3","turn":0,"modelCallId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation","modelAttemptId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation:attempt:0","attempt":0,"completedAt":1788636315352,"usage":{"inputTokens":{},"outputTokens":{}},"usageAt":1788636315351,"finishReason":"stop"}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 8, 'run_mtorvpnj_1w9jn4l8qct:8', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:8","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":8,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"attemptId":"run_mtorvpnj_1w9jn4l8qct:attempt:1","rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.363Z","_tag":"ModelCallCompleted","deliveryId":"id_CVqeu75hLaMP5WoE:4","turn":0,"modelCallId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation","purpose":"conversation","attempts":1,"completedAt":1788636315352,"usage":{"inputTokens":{},"outputTokens":{}},"finishReason":"stop"}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 9, 'run_mtorvpnj_1w9jn4l8qct:9', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:9","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":9,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"attemptId":"run_mtorvpnj_1w9jn4l8qct:attempt:1","rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.408Z","_tag":"TurnCompleted","turn":0,"usage":{"inputTokens":{},"outputTokens":{}},"finishReason":"stop"}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpnj_1w9jn4l8qct', 10, 'run_mtorvpnj_1w9jn4l8qct:10', '{"specVersion":"1","eventId":"run_mtorvpnj_1w9jn4l8qct:10","runId":"run_mtorvpnj_1w9jn4l8qct","sequence":10,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"attemptId":"run_mtorvpnj_1w9jn4l8qct:attempt:1","rootRunId":"run_mtorvpnj_1w9jn4l8qct","depth":0,"correlationId":"completed","occurredAt":"2026-09-05T19:25:15.414Z","_tag":"RunCompleted","result":{"text":"BEFORE_UPGRADE","turns":1,"session":{"sessionId":"completed-session","leafId":"run_mtorvpnj_1w9jn4l8qct:model-response-committed:run_mtorvpnj_1w9jn4l8qct:model:0:0:conversation"}}}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvpr3_dufuvjjwyz', 0, 'run_mtorvpr3_dufuvjjwyz:0', '{"specVersion":"1","eventId":"run_mtorvpr3_dufuvjjwyz:0","runId":"run_mtorvpr3_dufuvjjwyz","sequence":0,"executableRef":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"rootRunId":"run_mtorvpr3_dufuvjjwyz","depth":0,"correlationId":"pending","occurredAt":"2026-09-05T19:25:15.424Z","_tag":"RunAccepted","messageId":"start:pending","address":"runtime:start"}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvprc_1d4z7t4lv6e', 0, 'run_mtorvprc_1d4z7t4lv6e:0', '{"specVersion":"1","eventId":"run_mtorvprc_1d4z7t4lv6e:0","runId":"run_mtorvprc_1d4z7t4lv6e","sequence":0,"executableRef":{"executable":"executable-pin:v1:sha256:bbc41b2677ae43b6202d52c153074189b801b00fc6b558cdee152eba94d6d2af","active":"agent-pin:v1:sha256:be29675f85792ec0f71d29d38ae8b96a0b4c8bc8c679336ad7044dd8b6603ffc"},"rootRunId":"run_mtorvprc_1d4z7t4lv6e","depth":0,"correlationId":"interrupted","occurredAt":"2026-09-05T19:25:15.433Z","_tag":"RunAccepted","messageId":"start:interrupted","address":"runtime:start"}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvprc_1d4z7t4lv6e', 1, 'run_mtorvprc_1d4z7t4lv6e:1', '{"specVersion":"1","eventId":"run_mtorvprc_1d4z7t4lv6e:1","runId":"run_mtorvprc_1d4z7t4lv6e","sequence":1,"executableRef":{"executable":"executable-pin:v1:sha256:bbc41b2677ae43b6202d52c153074189b801b00fc6b558cdee152eba94d6d2af","active":"agent-pin:v1:sha256:be29675f85792ec0f71d29d38ae8b96a0b4c8bc8c679336ad7044dd8b6603ffc"},"attemptId":"run_mtorvprc_1d4z7t4lv6e:attempt:1","rootRunId":"run_mtorvprc_1d4z7t4lv6e","depth":0,"correlationId":"interrupted","occurredAt":"2026-09-05T19:25:15.434Z","_tag":"RunAttemptStarted","attempt":1}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvprc_1d4z7t4lv6e', 2, 'run_mtorvprc_1d4z7t4lv6e:2', '{"specVersion":"1","eventId":"run_mtorvprc_1d4z7t4lv6e:2","runId":"run_mtorvprc_1d4z7t4lv6e","sequence":2,"executableRef":{"executable":"executable-pin:v1:sha256:bbc41b2677ae43b6202d52c153074189b801b00fc6b558cdee152eba94d6d2af","active":"agent-pin:v1:sha256:be29675f85792ec0f71d29d38ae8b96a0b4c8bc8c679336ad7044dd8b6603ffc"},"attemptId":"run_mtorvprc_1d4z7t4lv6e:attempt:1","rootRunId":"run_mtorvprc_1d4z7t4lv6e","depth":0,"correlationId":"interrupted","occurredAt":"2026-09-05T19:25:15.449Z","_tag":"TurnStarted","turn":0}');
INSERT INTO public.generalist_run_events VALUES ('run_mtorvprc_1d4z7t4lv6e', 3, 'run_mtorvprc_1d4z7t4lv6e:3', '{"specVersion":"1","eventId":"run_mtorvprc_1d4z7t4lv6e:3","runId":"run_mtorvprc_1d4z7t4lv6e","sequence":3,"executableRef":{"executable":"executable-pin:v1:sha256:bbc41b2677ae43b6202d52c153074189b801b00fc6b558cdee152eba94d6d2af","active":"agent-pin:v1:sha256:be29675f85792ec0f71d29d38ae8b96a0b4c8bc8c679336ad7044dd8b6603ffc"},"attemptId":"run_mtorvprc_1d4z7t4lv6e:attempt:1","rootRunId":"run_mtorvprc_1d4z7t4lv6e","depth":0,"correlationId":"interrupted","occurredAt":"2026-09-05T19:25:15.468Z","_tag":"OperationUnknown","operationId":"op_mtorvprv_2e48905orqw"}');
INSERT INTO public.generalist_run_operations VALUES ('run_mtorvpnj_1w9jn4l8qct', 'op_mtorvpo6_1c53rp16nav', 'run_mtorvpnj_1w9jn4l8qct:memory:recall:0', 'memory', 'succeeded', '305641ce9846d7a22e13029f91a1e1b80d7b46c64ab5ba76b4bb9ad503abab1e', '{"turn":0}', '{"content":[{"options":{},"role":"user","content":"before"}]}', NULL, 'pure', 1, NULL, NULL, '2026-09-05 13:25:15.32-06', '2026-09-05 13:25:15.324-06', NULL, NULL);
INSERT INTO public.generalist_run_operations VALUES ('run_mtorvpnj_1w9jn4l8qct', 'op_mtorvpon_11jbpk65do5', 'run_mtorvpnj_1w9jn4l8qct:memory:sync:0:1:0ebb8ce8734f0de3e7f9cd3d5d8283cb8faf454a06da4e8b254cfb8939bb8522', 'memory', 'succeeded', '4b53d2446ad837a47d59fbe306cefa55fbf8aad682db641d732f863ff7ba4097', '{"turn":0,"messageCount":1,"transcriptDigest":"0ebb8ce8734f0de3e7f9cd3d5d8283cb8faf454a06da4e8b254cfb8939bb8522"}', '{"leafId":"run_mtorvpnj_1w9jn4l8qct:model:0:session-entry:root:0:user"}', NULL, 'pure', 1, NULL, NULL, '2026-09-05 13:25:15.337-06', '2026-09-05 13:25:15.341-06', NULL, NULL);
INSERT INTO public.generalist_run_operations VALUES ('run_mtorvpnj_1w9jn4l8qct', 'op_mtorvpoj_2gb6jp3b6jt', 'run_mtorvpnj_1w9jn4l8qct:model:0:0:conversation', 'model', 'succeeded', 'd96090746e75aeab17cb6124b40f9da8c42dcf9a0963f4eaf93b73a7f0454d40', '{"turn":0,"modelCallOrdinal":0,"purpose":"conversation","promptDigest":"0ebb8ce8734f0de3e7f9cd3d5d8283cb8faf454a06da4e8b254cfb8939bb8522"}', '{"operationId":"run_mtorvpnj_1w9jn4l8qct:model:0:0:conversation","turn":0,"modelCallId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation","modelAttemptId":"run_mtorvpnj_1w9jn4l8qct:model-call:0:conversation:attempt:0","attempt":0,"sessionId":"completed-session","sessionParentId":"run_mtorvpnj_1w9jn4l8qct:model:0:session-entry:root:0:user","sessionEntryId":"run_mtorvpnj_1w9jn4l8qct:model-response-committed:run_mtorvpnj_1w9jn4l8qct:model:0:0:conversation","budgetCharge":0,"transitionDigest":"1e46bc0d0b8eacd22a251119fd942cb4981ab73566d55670228d75703fa0ab71","digest":"624e9a9033c5f79ee7f3c146c3ec45290079e7715d430855e9be00b033927b62","usage":{"inputTokens":{},"outputTokens":{}},"finishReason":"stop"}', NULL, 'never', 1, NULL, NULL, '2026-09-05 13:25:15.333-06', '2026-09-05 13:25:15.357-06', NULL, NULL);
INSERT INTO public.generalist_run_operations VALUES ('run_mtorvpnj_1w9jn4l8qct', 'op_mtorvppo_8prnloxkwb', 'run_mtorvpnj_1w9jn4l8qct:memory:sync:0:2:cd29b7346dea1b3d79d2f2b0cd29a55859574834cadbc74814185baaf048c5e8', 'memory', 'succeeded', '6544677fe4bc11dd58a511fa38ccfe4918e3136614eb12349244c77eb05d8690', '{"turn":0,"messageCount":2,"transcriptDigest":"cd29b7346dea1b3d79d2f2b0cd29a55859574834cadbc74814185baaf048c5e8"}', '{"leafId":"run_mtorvpnj_1w9jn4l8qct:model-response-committed:run_mtorvpnj_1w9jn4l8qct:model:0:0:conversation"}', NULL, 'pure', 1, NULL, NULL, '2026-09-05 13:25:15.375-06', '2026-09-05 13:25:15.392-06', NULL, NULL);
INSERT INTO public.generalist_run_operations VALUES ('run_mtorvpnj_1w9jn4l8qct', 'op_mtorvpqe_i7ukd58052', 'run_mtorvpnj_1w9jn4l8qct:memory:remember:0:1', 'memory', 'succeeded', 'cf86b2ce8d4675ae496526f987b94ffec4ab18bc8b96300b8afaef80ec8c1680', '{"turn":0,"terminal":true}', 'null', NULL, 'pure', 1, NULL, NULL, '2026-09-05 13:25:15.4-06', '2026-09-05 13:25:15.402-06', NULL, NULL);
INSERT INTO public.generalist_run_operations VALUES ('run_mtorvprc_1d4z7t4lv6e', 'op_mtorvprn_12ogsw1savk', 'run_mtorvprc_1d4z7t4lv6e:memory:recall:0', 'memory', 'succeeded', '305641ce9846d7a22e13029f91a1e1b80d7b46c64ab5ba76b4bb9ad503abab1e', '{"turn":0}', '{"content":[{"options":{},"role":"user","content":"resume after upgrade"}]}', NULL, 'pure', 1, NULL, NULL, '2026-09-05 13:25:15.445-06', '2026-09-05 13:25:15.447-06', NULL, NULL);
INSERT INTO public.generalist_run_operations VALUES ('run_mtorvprc_1d4z7t4lv6e', 'op_mtorvpry_18wv2trb9m5', 'run_mtorvprc_1d4z7t4lv6e:memory:sync:0:1:8f16534f599b446fd0de63427ce1ae468dfc889e0e686c8e8ca2147bca23516c', 'memory', 'succeeded', 'ad423e764b699bdb1c1942a7c764cc842cebe21bce17147d90f641672a259e4e', '{"turn":0,"messageCount":1,"transcriptDigest":"8f16534f599b446fd0de63427ce1ae468dfc889e0e686c8e8ca2147bca23516c"}', '{"leafId":"run_mtorvprc_1d4z7t4lv6e:model:0:session-entry:root:0:user"}', NULL, 'pure', 1, NULL, NULL, '2026-09-05 13:25:15.456-06', '2026-09-05 13:25:15.459-06', NULL, NULL);
INSERT INTO public.generalist_run_operations VALUES ('run_mtorvprc_1d4z7t4lv6e', 'op_mtorvprv_2e48905orqw', 'run_mtorvprc_1d4z7t4lv6e:model:0:0:conversation', 'model', 'unknown', '4318ade44e42799d5c3aaf9abd39de703645277e10d2763a9ceb7e91ff1f91c9', '{"turn":0,"modelCallOrdinal":0,"purpose":"conversation","promptDigest":"8f16534f599b446fd0de63427ce1ae468dfc889e0e686c8e8ca2147bca23516c"}', NULL, NULL, 'never', 1, NULL, NULL, '2026-09-05 13:25:15.453-06', '2026-09-05 13:25:15.468-06', NULL, NULL);
INSERT INTO public.generalist_run_registrations VALUES ('run_mtorvpnj_1w9jn4l8qct', 'capability-pin:v1:sha256:dd986e4275d8557e4c67c5ac5abc4a274388062cba29f1a24a832cbb4a24928e');
INSERT INTO public.generalist_run_registrations VALUES ('run_mtorvpnj_1w9jn4l8qct', 'model-pin:v1:sha256:8b9320cf56b68efc2732b4c8161df968a12092457a3ef52a04f6cdd8b6017b2c');
INSERT INTO public.generalist_run_registrations VALUES ('run_mtorvpr3_dufuvjjwyz', 'capability-pin:v1:sha256:dd986e4275d8557e4c67c5ac5abc4a274388062cba29f1a24a832cbb4a24928e');
INSERT INTO public.generalist_run_registrations VALUES ('run_mtorvpr3_dufuvjjwyz', 'model-pin:v1:sha256:8b9320cf56b68efc2732b4c8161df968a12092457a3ef52a04f6cdd8b6017b2c');
INSERT INTO public.generalist_run_registrations VALUES ('run_mtorvprc_1d4z7t4lv6e', 'capability-pin:v1:sha256:0fbb160d488f8a11895b7905f75990c787f73f475b1c0a3a9a8089d7c97d97bf');
INSERT INTO public.generalist_run_registrations VALUES ('run_mtorvprc_1d4z7t4lv6e', 'model-pin:v1:sha256:4306c3a05abe06f6483520cb224ea772d090c4f39bb8f5705ef6c8c0b5cdbc04');
INSERT INTO public.generalist_runs VALUES ('run_mtorvpr3_dufuvjjwyz', 'queued', 'runtime:start', 'pending-session', 'start:pending', '{"id":"start:pending","to":"runtime:start","sessionId":"pending-session","prompt":{"content":[{"options":{},"role":"user","content":"after"}]},"idempotencyKey":"pending","correlationId":"pending","metadata":{}}', '4ab37c3a1ae097114dc8ebff8f851502e33bbf1e6066f9d42c822961b3961447', 'pending', '{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"}', '{"version":"2","root":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2","profiles":[],"entries":[{"_tag":"Agent","pin":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2","manifest":{"version":"2","name":"upgrade-fixture","model":"model-pin:v1:sha256:8b9320cf56b68efc2732b4c8161df968a12092457a3ef52a04f6cdd8b6017b2c","tools":[],"skills":[],"services":[],"policy":{"_tag":"Pinned","pin":"capability-pin:v1:sha256:dd986e4275d8557e4c67c5ac5abc4a274388062cba29f1a24a832cbb4a24928e"},"toolScheduling":{"maxConcurrency":1,"parallelSafe":[]},"budget":{},"children":[]}}]}', 'run_mtorvpr3_dufuvjjwyz', 0, 1024, 1024, NULL, NULL, 0, 0, 0, -1, false, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, '2026-09-05 13:25:15.423-06', '2026-09-05 13:25:15.424-06');
INSERT INTO public.generalist_runs VALUES ('run_mtorvpnj_1w9jn4l8qct', 'succeeded', 'runtime:start', 'completed-session', 'start:completed', '{"id":"start:completed","to":"runtime:start","sessionId":"completed-session","prompt":{"content":[{"options":{},"role":"user","content":"before"}]},"idempotencyKey":"completed","correlationId":"completed","metadata":{}}', '97f0ff6642d062100b6cde5c40396c6a55db87d2add0a86fd9d7f8087215bf7b', 'completed', '{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"}', '{"version":"2","root":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2","profiles":[],"entries":[{"_tag":"Agent","pin":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2","manifest":{"version":"2","name":"upgrade-fixture","model":"model-pin:v1:sha256:8b9320cf56b68efc2732b4c8161df968a12092457a3ef52a04f6cdd8b6017b2c","tools":[],"skills":[],"services":[],"policy":{"_tag":"Pinned","pin":"capability-pin:v1:sha256:dd986e4275d8557e4c67c5ac5abc4a274388062cba29f1a24a832cbb4a24928e"},"toolScheduling":{"maxConcurrency":1,"parallelSafe":[]},"budget":{},"children":[]}}]}', 'run_mtorvpnj_1w9jn4l8qct', 0, 1024, 1024, NULL, NULL, 1, 2, 10, 9, false, NULL, 'run_mtorvpnj_1w9jn4l8qct:10', 0, '{"driverVersion":"1","executable":{"executable":"executable-pin:v1:sha256:0fedcd1be43ddcff19f9dd9f9143e7c61cd72e622e1960e6a65e8e62d03cd66b","active":"agent-pin:v1:sha256:ab8c902ce982986dbbb1f73e4bc9ce8e2e17e92047abc516644f41e7e17eb7b2"},"turn":0,"budget":{"allocation":{},"remaining":{},"depth":0},"state":{"logicalOperationId":"run_mtorvpnj_1w9jn4l8qct","sessionId":"completed-session","modelCallOrdinal":1,"modelCallOrdinalStart":0}}', NULL, NULL, NULL, NULL, NULL, '2026-09-05 13:25:15.295-06', '2026-09-05 13:25:15.415-06');
INSERT INTO public.generalist_runs VALUES ('run_mtorvprc_1d4z7t4lv6e', 'needs-resolution', 'runtime:start', 'interrupted-session', 'start:interrupted', '{"id":"start:interrupted","to":"runtime:start","sessionId":"interrupted-session","prompt":{"content":[{"options":{},"role":"user","content":"resume after upgrade"}]},"idempotencyKey":"interrupted","correlationId":"interrupted","metadata":{}}', '44519cc717a0ffcb20aee91cbae246fcd5cded40ab0eb2ed02479e75b41c8cf1', 'interrupted', '{"executable":"executable-pin:v1:sha256:bbc41b2677ae43b6202d52c153074189b801b00fc6b558cdee152eba94d6d2af","active":"agent-pin:v1:sha256:be29675f85792ec0f71d29d38ae8b96a0b4c8bc8c679336ad7044dd8b6603ffc"}', '{"version":"2","root":"agent-pin:v1:sha256:be29675f85792ec0f71d29d38ae8b96a0b4c8bc8c679336ad7044dd8b6603ffc","profiles":[],"entries":[{"_tag":"Agent","pin":"agent-pin:v1:sha256:be29675f85792ec0f71d29d38ae8b96a0b4c8bc8c679336ad7044dd8b6603ffc","manifest":{"version":"2","name":"upgrade-delayed","model":"model-pin:v1:sha256:4306c3a05abe06f6483520cb224ea772d090c4f39bb8f5705ef6c8c0b5cdbc04","tools":[],"skills":[],"services":[],"policy":{"_tag":"Pinned","pin":"capability-pin:v1:sha256:0fbb160d488f8a11895b7905f75990c787f73f475b1c0a3a9a8089d7c97d97bf"},"toolScheduling":{"maxConcurrency":1,"parallelSafe":[]},"budget":{},"children":[]}}]}', 'run_mtorvprc_1d4z7t4lv6e', 0, 1024, 1024, NULL, NULL, 1, 2, 3, -1, false, NULL, NULL, 0, '{"driverVersion":"1","executable":{"executable":"executable-pin:v1:sha256:bbc41b2677ae43b6202d52c153074189b801b00fc6b558cdee152eba94d6d2af","active":"agent-pin:v1:sha256:be29675f85792ec0f71d29d38ae8b96a0b4c8bc8c679336ad7044dd8b6603ffc"},"turn":0,"budget":{"allocation":{},"remaining":{},"depth":0},"state":{"logicalOperationId":"run_mtorvprc_1d4z7t4lv6e","sessionId":"interrupted-session","modelCallOrdinal":1,"modelCallOrdinalStart":0,"pending":{"kind":"model","key":"run_mtorvprc_1d4z7t4lv6e:model:0:0:conversation","input":{"turn":0,"modelCallOrdinal":0,"purpose":"conversation","promptDigest":"8f16534f599b446fd0de63427ce1ae468dfc889e0e686c8e8ca2147bca23516c"},"replayPolicy":"never"}}}', NULL, NULL, NULL, NULL, NULL, '2026-09-05 13:25:15.432-06', '2026-09-05 13:25:15.47-06');
INSERT INTO public.generalist_schema_meta VALUES (1, 4, 'c9ff31038d2758d3398dc9836880285b23a0428fd0a08c4c0752757a6e647d4a', false, '2026-09-05 13:25:15.279-06');
INSERT INTO public.generalist_session_entries VALUES ('completed-session', 'run_mtorvpnj_1w9jn4l8qct:model:0:session-entry:root:0:user', NULL, 0, 'Message', '{"_tag":"Message","message":{"options":{},"role":"user","content":"before"}}', '2026-09-05 13:25:15.339-06');
INSERT INTO public.generalist_session_entries VALUES ('completed-session', 'run_mtorvpnj_1w9jn4l8qct:model-response-committed:run_mtorvpnj_1w9jn4l8qct:model:0:0:conversation', 'run_mtorvpnj_1w9jn4l8qct:model:0:session-entry:root:0:user', 1, 'ModelResponse', '{"_tag":"ModelResponse","content":[{"metadata":{},"type":"text","text":"BEFORE_UPGRADE"},{"metadata":{},"type":"finish","reason":"stop","usage":{"inputTokens":{"uncached":{"generalist/runtime/session-codec":"undefined"},"total":{"generalist/runtime/session-codec":"undefined"},"cacheRead":{"generalist/runtime/session-codec":"undefined"},"cacheWrite":{"generalist/runtime/session-codec":"undefined"}},"outputTokens":{"total":{"generalist/runtime/session-codec":"undefined"},"text":{"generalist/runtime/session-codec":"undefined"},"reasoning":{"generalist/runtime/session-codec":"undefined"}}},"response":{"generalist/runtime/session-codec":"undefined"}}],"metadata":{"modelResponseDigest":"624e9a9033c5f79ee7f3c146c3ec45290079e7715d430855e9be00b033927b62"}}', '2026-09-05 13:25:15.356-06');
INSERT INTO public.generalist_session_entries VALUES ('interrupted-session', 'run_mtorvprc_1d4z7t4lv6e:model:0:session-entry:root:0:user', NULL, 0, 'Message', '{"_tag":"Message","message":{"options":{},"role":"user","content":"resume after upgrade"}}', '2026-09-05 13:25:15.457-06');
INSERT INTO public.generalist_sessions VALUES ('completed-session', 'run_mtorvpnj_1w9jn4l8qct:model-response-committed:run_mtorvpnj_1w9jn4l8qct:model:0:0:conversation', 2, 1, NULL, NULL, NULL, '2026-09-05 13:25:15.356-06');
INSERT INTO public.generalist_sessions VALUES ('interrupted-session', 'run_mtorvprc_1d4z7t4lv6e:model:0:session-entry:root:0:user', 1, 1, NULL, NULL, NULL, '2026-09-05 13:25:15.457-06');
INSERT INTO public.generalist_sql_migrations VALUES (1, '2026-09-05 13:25:15.260306-06', 'generalist_runtime');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 0, 'run_mtorvpnj_1w9jn4l8qct', 0, 'run_mtorvpnj_1w9jn4l8qct:0');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 1, 'run_mtorvpnj_1w9jn4l8qct', 1, 'run_mtorvpnj_1w9jn4l8qct:1');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 2, 'run_mtorvpnj_1w9jn4l8qct', 2, 'run_mtorvpnj_1w9jn4l8qct:2');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 3, 'run_mtorvpnj_1w9jn4l8qct', 3, 'run_mtorvpnj_1w9jn4l8qct:3');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 4, 'run_mtorvpnj_1w9jn4l8qct', 4, 'run_mtorvpnj_1w9jn4l8qct:4');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 5, 'run_mtorvpnj_1w9jn4l8qct', 5, 'run_mtorvpnj_1w9jn4l8qct:5');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 6, 'run_mtorvpnj_1w9jn4l8qct', 6, 'run_mtorvpnj_1w9jn4l8qct:6');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 7, 'run_mtorvpnj_1w9jn4l8qct', 7, 'run_mtorvpnj_1w9jn4l8qct:7');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 8, 'run_mtorvpnj_1w9jn4l8qct', 8, 'run_mtorvpnj_1w9jn4l8qct:8');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 9, 'run_mtorvpnj_1w9jn4l8qct', 9, 'run_mtorvpnj_1w9jn4l8qct:9');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpnj_1w9jn4l8qct', 10, 'run_mtorvpnj_1w9jn4l8qct', 10, 'run_mtorvpnj_1w9jn4l8qct:10');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvpr3_dufuvjjwyz', 0, 'run_mtorvpr3_dufuvjjwyz', 0, 'run_mtorvpr3_dufuvjjwyz:0');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvprc_1d4z7t4lv6e', 0, 'run_mtorvprc_1d4z7t4lv6e', 0, 'run_mtorvprc_1d4z7t4lv6e:0');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvprc_1d4z7t4lv6e', 1, 'run_mtorvprc_1d4z7t4lv6e', 1, 'run_mtorvprc_1d4z7t4lv6e:1');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvprc_1d4z7t4lv6e', 2, 'run_mtorvprc_1d4z7t4lv6e', 2, 'run_mtorvprc_1d4z7t4lv6e:2');
INSERT INTO public.generalist_tree_event_index VALUES ('run_mtorvprc_1d4z7t4lv6e', 3, 'run_mtorvprc_1d4z7t4lv6e', 3, 'run_mtorvprc_1d4z7t4lv6e:3');
INSERT INTO public.generalist_tree_roots VALUES ('run_mtorvpnj_1w9jn4l8qct', 0, 10);
INSERT INTO public.generalist_tree_roots VALUES ('run_mtorvpr3_dufuvjjwyz', 0, 0);
INSERT INTO public.generalist_tree_roots VALUES ('run_mtorvprc_1d4z7t4lv6e', 0, 3);
ALTER TABLE ONLY public.generalist_agent_names
    ADD CONSTRAINT generalist_agent_names_pkey PRIMARY KEY (scope, name);
ALTER TABLE ONLY public.generalist_executable_registrations
    ADD CONSTRAINT generalist_executable_registrations_pkey PRIMARY KEY (pin);
ALTER TABLE ONLY public.generalist_external_child_placements
    ADD CONSTRAINT generalist_external_child_place_parent_run_id_invocation_id_key UNIQUE (parent_run_id, invocation_id);
ALTER TABLE ONLY public.generalist_external_child_placements
    ADD CONSTRAINT generalist_external_child_placeme_partition_external_run_id_key UNIQUE (partition, external_run_id);
ALTER TABLE ONLY public.generalist_external_child_placements
    ADD CONSTRAINT generalist_external_child_placements_pkey PRIMARY KEY (placement_id);
ALTER TABLE ONLY public.generalist_external_roots
    ADD CONSTRAINT generalist_external_roots_pkey PRIMARY KEY (placement_id);
ALTER TABLE ONLY public.generalist_external_roots
    ADD CONSTRAINT generalist_external_roots_run_id_key UNIQUE (run_id);
ALTER TABLE ONLY public.generalist_fan_out_members
    ADD CONSTRAINT generalist_fan_out_members_child_run_id_key UNIQUE (child_run_id);
ALTER TABLE ONLY public.generalist_fan_out_members
    ADD CONSTRAINT generalist_fan_out_members_fan_out_id_member_key_key UNIQUE (fan_out_id, member_key);
ALTER TABLE ONLY public.generalist_fan_out_members
    ADD CONSTRAINT generalist_fan_out_members_pkey PRIMARY KEY (fan_out_id, ordinal);
ALTER TABLE ONLY public.generalist_fan_outs
    ADD CONSTRAINT generalist_fan_outs_parent_run_id_idempotency_key_key UNIQUE (parent_run_id, idempotency_key);
ALTER TABLE ONLY public.generalist_fan_outs
    ADD CONSTRAINT generalist_fan_outs_pkey PRIMARY KEY (fan_out_id);
ALTER TABLE ONLY public.generalist_lanes
    ADD CONSTRAINT generalist_lanes_pkey PRIMARY KEY (session_id);
ALTER TABLE ONLY public.generalist_messages
    ADD CONSTRAINT generalist_messages_pkey PRIMARY KEY (entry_id);
ALTER TABLE ONLY public.generalist_messages
    ADD CONSTRAINT generalist_messages_target_session_id_message_id_idempotenc_key UNIQUE (target_session_id, message_id, idempotency_key);
ALTER TABLE ONLY public.generalist_messages
    ADD CONSTRAINT generalist_messages_target_session_id_sequence_key UNIQUE (target_session_id, sequence);
ALTER TABLE ONLY public.generalist_program_operations
    ADD CONSTRAINT generalist_program_operations_pkey PRIMARY KEY (run_id, operation_name);
ALTER TABLE ONLY public.generalist_program_runs
    ADD CONSTRAINT generalist_program_runs_pkey PRIMARY KEY (run_id);
ALTER TABLE ONLY public.generalist_run_acknowledgements
    ADD CONSTRAINT generalist_run_acknowledgements_pkey PRIMARY KEY (run_id);
ALTER TABLE ONLY public.generalist_run_events
    ADD CONSTRAINT generalist_run_events_event_id_key UNIQUE (event_id);
ALTER TABLE ONLY public.generalist_run_events
    ADD CONSTRAINT generalist_run_events_pkey PRIMARY KEY (run_id, sequence);
ALTER TABLE ONLY public.generalist_run_links
    ADD CONSTRAINT generalist_run_links_child_run_id_key UNIQUE (child_run_id);
ALTER TABLE ONLY public.generalist_run_links
    ADD CONSTRAINT generalist_run_links_pkey PRIMARY KEY (parent_run_id, child_run_id);
ALTER TABLE ONLY public.generalist_run_operations
    ADD CONSTRAINT generalist_run_operations_pkey PRIMARY KEY (run_id, operation_id);
ALTER TABLE ONLY public.generalist_run_operations
    ADD CONSTRAINT generalist_run_operations_run_id_operation_key_key UNIQUE (run_id, operation_key);
ALTER TABLE ONLY public.generalist_run_registrations
    ADD CONSTRAINT generalist_run_registrations_pkey PRIMARY KEY (run_id, pin);
ALTER TABLE ONLY public.generalist_run_steering
    ADD CONSTRAINT generalist_run_steering_pkey PRIMARY KEY (entry_id);
ALTER TABLE ONLY public.generalist_run_steering
    ADD CONSTRAINT generalist_run_steering_run_id_idempotency_key_key UNIQUE (run_id, idempotency_key);
ALTER TABLE ONLY public.generalist_run_steering
    ADD CONSTRAINT generalist_run_steering_run_id_sequence_key UNIQUE (run_id, sequence);
ALTER TABLE ONLY public.generalist_run_waits
    ADD CONSTRAINT generalist_run_waits_pkey PRIMARY KEY (run_id, wait_id);
ALTER TABLE ONLY public.generalist_runs
    ADD CONSTRAINT generalist_runs_address_session_id_idempotency_key_key UNIQUE (address, session_id, idempotency_key);
ALTER TABLE ONLY public.generalist_runs
    ADD CONSTRAINT generalist_runs_pkey PRIMARY KEY (run_id);
ALTER TABLE ONLY public.generalist_schema_meta
    ADD CONSTRAINT generalist_schema_meta_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.generalist_session_entries
    ADD CONSTRAINT generalist_session_entries_pkey PRIMARY KEY (session_id, entry_id);
ALTER TABLE ONLY public.generalist_sessions
    ADD CONSTRAINT generalist_sessions_pkey PRIMARY KEY (session_id);
ALTER TABLE ONLY public.generalist_sql_migrations
    ADD CONSTRAINT generalist_sql_migrations_pkey PRIMARY KEY (migration_id);
ALTER TABLE ONLY public.generalist_tree_event_index
    ADD CONSTRAINT generalist_tree_event_index_event_id_key UNIQUE (event_id);
ALTER TABLE ONLY public.generalist_tree_event_index
    ADD CONSTRAINT generalist_tree_event_index_pkey PRIMARY KEY (root_run_id, "position");
ALTER TABLE ONLY public.generalist_tree_event_index
    ADD CONSTRAINT generalist_tree_event_index_run_id_run_sequence_key UNIQUE (run_id, run_sequence);
ALTER TABLE ONLY public.generalist_tree_roots
    ADD CONSTRAINT generalist_tree_roots_pkey PRIMARY KEY (root_run_id);
CREATE INDEX generalist_agent_names_run_idx ON public.generalist_agent_names USING btree (run_id);
CREATE INDEX generalist_external_child_placements_parent_idx ON public.generalist_external_child_placements USING btree (parent_run_id, settlement_id, created_at);
CREATE INDEX generalist_fan_out_members_status_idx ON public.generalist_fan_out_members USING btree (fan_out_id, status, ordinal);
CREATE INDEX generalist_lanes_head_idx ON public.generalist_lanes USING btree (head_run_id);
CREATE INDEX generalist_messages_pending_idx ON public.generalist_messages USING btree (target_session_id, sequence) WHERE (delivered_run_id IS NULL);
CREATE INDEX generalist_run_links_readiness_idx ON public.generalist_run_links USING btree (parent_run_id, readiness, created_at, child_run_id);
CREATE INDEX generalist_run_operations_status_idx ON public.generalist_run_operations USING btree (status);
CREATE INDEX generalist_run_registrations_pin_idx ON public.generalist_run_registrations USING btree (pin);
CREATE INDEX generalist_run_steering_pending_idx ON public.generalist_run_steering USING btree (run_id, sequence) WHERE ((consumed_operation_id IS NULL) AND (discarded_reason IS NULL));
CREATE INDEX generalist_run_waits_due_idx ON public.generalist_run_waits USING btree (status, due_at);
CREATE INDEX generalist_runs_claim_idx ON public.generalist_runs USING btree (status, lease_expires_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting'::text, 'needs-resolution'::text, 'cancelling'::text]));
CREATE INDEX generalist_session_entries_parent_idx ON public.generalist_session_entries USING btree (session_id, parent_id);
CREATE UNIQUE INDEX generalist_session_entries_seq_idx ON public.generalist_session_entries USING btree (session_id, seq);
ALTER TABLE ONLY public.generalist_agent_names
    ADD CONSTRAINT generalist_agent_names_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_external_child_placements
    ADD CONSTRAINT generalist_external_child_placements_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_external_roots
    ADD CONSTRAINT generalist_external_roots_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_fan_out_members
    ADD CONSTRAINT generalist_fan_out_members_child_run_id_fkey FOREIGN KEY (child_run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_fan_out_members
    ADD CONSTRAINT generalist_fan_out_members_fan_out_id_fkey FOREIGN KEY (fan_out_id) REFERENCES public.generalist_fan_outs(fan_out_id);
ALTER TABLE ONLY public.generalist_fan_outs
    ADD CONSTRAINT generalist_fan_outs_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_program_operations
    ADD CONSTRAINT generalist_program_operations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.generalist_program_runs(run_id);
ALTER TABLE ONLY public.generalist_program_runs
    ADD CONSTRAINT generalist_program_runs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_run_acknowledgements
    ADD CONSTRAINT generalist_run_acknowledgements_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_run_events
    ADD CONSTRAINT generalist_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_run_links
    ADD CONSTRAINT generalist_run_links_child_run_id_fkey FOREIGN KEY (child_run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_run_links
    ADD CONSTRAINT generalist_run_links_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_run_operations
    ADD CONSTRAINT generalist_run_operations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_run_registrations
    ADD CONSTRAINT generalist_run_registrations_pin_fkey FOREIGN KEY (pin) REFERENCES public.generalist_executable_registrations(pin);
ALTER TABLE ONLY public.generalist_run_registrations
    ADD CONSTRAINT generalist_run_registrations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_run_steering
    ADD CONSTRAINT generalist_run_steering_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_run_waits
    ADD CONSTRAINT generalist_run_waits_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.generalist_runs(run_id);
ALTER TABLE ONLY public.generalist_tree_event_index
    ADD CONSTRAINT generalist_tree_event_index_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.generalist_run_events(event_id);
ALTER TABLE ONLY public.generalist_tree_event_index
    ADD CONSTRAINT generalist_tree_event_index_root_run_id_fkey FOREIGN KEY (root_run_id) REFERENCES public.generalist_tree_roots(root_run_id);
ALTER TABLE ONLY public.generalist_tree_event_index
    ADD CONSTRAINT generalist_tree_event_index_run_id_run_sequence_fkey FOREIGN KEY (run_id, run_sequence) REFERENCES public.generalist_run_events(run_id, sequence);
ALTER TABLE ONLY public.generalist_tree_roots
    ADD CONSTRAINT generalist_tree_roots_root_run_id_fkey FOREIGN KEY (root_run_id) REFERENCES public.generalist_runs(run_id);
