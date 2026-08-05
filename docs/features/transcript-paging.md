# Transcript paging

Clients read semantic transcript units, never raw Baton pages. The initial read starts with the newest fifty units and continues backward to at least two hundred units and the nearest Turn boundary; later reads use a stable keyset cursor ordered by Turn time, Turn identity, source sequence, part, and unit key.

Pages report whether older units remain and preserve an anchor when prepended. Live delivery and paging share the same stored projection, so a reconnect or resync can replace a missed tail without duplicates or reordered content.
