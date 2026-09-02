# Hold tentative text across the commit-discard clear

Generalist clears its memory-only model preview lane twice: `discard` emits a
generation-0 clear the moment a model response commits to the durable journal,
and `clear` emits a newer-generation clear when the lane itself closes. The
durable text for that same commit still has a Postgres write, a terminal
inspection round trip, and (on hosted transport) a cursor-gated event ahead of
it, while the generation-0 clear travels memory-only with no ordering gate. The
clear therefore wins the race essentially every time the durable patch has not
already landed.

The interactive client used to unmount the tentative text on any clear, which
rendered one blank frame between the clear and the durable patch: the final
answer persisted, disappeared, and reappeared. Durable-first orderings never
blinked because `reconcile` already swaps the tentative units for the durable
units in a single update, which is why the symptom appeared intermittent.

The client now treats a generation-0 clear as a hold rather than a removal: the
last text stays mounted, the identity stays closed to late same-identity
frames, and the overlay is retired only when the durable unit carrying the
matching `modelResponseId` arrives (atomic swap), when a newer attempt or
model call supersedes it, or when terminal status, resync, or a
newer-generation clear replaces the whole overlay. The held text can only
linger past its durable arrival if the durable projection itself is lost, in
which case the existing resync path drops the overlay.
