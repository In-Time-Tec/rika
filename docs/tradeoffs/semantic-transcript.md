# Semantic transcript projection

**Gain:** stable grouping, bounded pages, keyed updates, and fast rendering for long Threads.

**Cost:** Rika maintains a rebuildable read model and checkpoints in addition to Baton's execution events.

**Rejected:** rebuilding the full transcript makes work grow with history; paging raw events cannot recover semantic groups without earlier state; copying OpenTUI internals breaks the package boundary.
