# Transcript projection

The Thread Projection is disposable semantic read state derived from Rika product metadata and Baton events. It stores stable keyed units, source order, revisions, model phase, cursor bounds, and a per-Turn checkpoint; assistant phases, cells, Child Runs, images, and errors all use this one projection shape.

Applying source events is idempotent, and replacing a projection cannot move to an older revision. Event application and checkpoint advancement are atomic. If projection data is absent, stale, or incomplete, Rika rebuilds it from Baton rather than treating it as execution truth.

Live model output is presented as a tentative overlay, not a projection revision. Baton's memory-only preview snapshots synthesize transient Reasoning and assistant units beside the durable transcript; the first authoritative semantic unit or terminal status for the same attempt replaces the overlay. Preview frames never enter the transcript repository; a resync or server replacement clears the overlay so it can never be mistaken for durable output. Pending local submissions are likewise an overlay: an echoed prompt survives snapshot and header-only patches until its durable prompt unit arrives.

Child Runs attach to the cell that requested them only through explicit `child_execution_id` and `invocation_id` event fields, and a cell-spawned child is placed by its invocation origin's operation key and ordinal. Projection never parses a child Run ID for a parent execution or tool call, and event payloads use canonical snake-case keys rather than accepting historical aliases.
