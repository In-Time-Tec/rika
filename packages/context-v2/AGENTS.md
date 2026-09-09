# Rika context v2

This package owns the Rika-specific Session materialization contract for the Generalist 0.65 coexistence path.

- Generalist owns Sessions, Runs, canonical component state, instruction snapshots, skill catalogs, and receipts.
- This package only defines Rika schemas, authenticated workspace reader seams, bounded capture, and attenuation helpers.
- A workspace binding is an explicit value supplied by the caller; never read the process cwd or an API checkout.
- Guidance and skill text are data. They never grant tools, models, credentials, or child authority.
- Credentials are secure references only. Never put a credential value in a schema, log, snapshot, or test fixture.
- Do not add a second journal, registry, cache, or persistence authority.

The legacy execution and extension packages remain untouched while v2 is qualified.
