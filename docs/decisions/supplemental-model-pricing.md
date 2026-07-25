# Pricing models that models.dev has not published

`usageCostUsd` returns undefined for any model missing from the models.dev snapshot, and a single
unpriced attempt marks a whole thread cost-incomplete, so the UI shows nothing rather than a
misleading partial total. That is the right default, but it means a model released before the
snapshot catches up silently blanks cost for every thread that touches it.

`claude-opus-5` shipped on 2026-07-24 and is absent from the snapshot, including the newest
published version. Anthropic priced it identically to its predecessor, so the supplement maps it
onto the `claude-opus-4-8` entry rather than restating rates, which keeps the two consistent if
the published numbers are ever corrected.

The supplement is only consulted when the direct lookup misses. The day models.dev publishes a
model, its real entry wins and the mapping becomes dead code that should be deleted.

Do not add an entry to guess at a price. An absent cost is a correct answer; a wrong cost is not.
