# Tests are type-checked where the source is, except in one package

**Gain:** `typecheck` runs per package, and a package that includes its tests holds a fixture to the same contract as the source it stands in for. `apps/rika` includes them now, so a value of the wrong type in its tests fails the same gate as one in its source. Closing it corrected fixtures carrying fields their events never had, a stream filter excluding a tag from another union, a type referenced across a boundary it was never exported across, and an options interface declaring inputs nothing reads.

**Cost:** `packages/product/tsconfig.json` still includes only `src`, so roughly sixty errors remain unseen there — almost all fixtures standing in for branded identities with plain strings. `diagnostics` reads every file in the repository but reports Effect's own rules rather than type errors, which is easy to mistake for coverage.

**Rejected:** correcting that package inside a migration would mix a large mechanical edit with unrelated work and hide whatever real defect sits among the noise, which is exactly what the equivalent edit here turned up. Deleting the fixtures instead of typing them would lose the cases they cover.
