# Transcript projection

The Thread Projection is disposable semantic read state derived from Rika product metadata and Baton events. It stores stable keyed units, source order, revisions, model phase, cursor bounds, and a per-Turn checkpoint; assistant phases, tools, Child Runs, images, and errors all use this one projection shape.

Applying source events is idempotent, and replacing a projection cannot move to an older revision. Event application and checkpoint advancement are atomic. If projection data is absent, stale, or incomplete, Rika rebuilds it from Baton rather than treating it as execution truth.

Child Runs attach to requesting tools only through explicit `child_execution_id` and `invocation_id` event fields. Projection never parses a child Run ID for a parent execution or tool call, and event payloads use canonical snake-case keys rather than accepting historical aliases.
