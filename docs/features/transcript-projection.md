# Transcript projection

The Thread Projection is disposable semantic read state derived from Rika product metadata and Relay events. It stores stable keyed units, source order, revisions, model phase, cursor bounds, and a per-Turn checkpoint; assistant phases, tools, Child Runs, workflows, images, and errors all use this one projection shape.

Applying source events is idempotent, and replacing a projection cannot move to an older revision. Event application and checkpoint advancement are atomic. If projection data is absent, stale, or incomplete, Rika rebuilds it from Relay rather than treating it as execution truth.
