# Rika API v2

This is the temporary greenfield API composition for issue #375. Keep the legacy `apps/api` application and its
Generalist SQL composition untouched while this app is qualified.

- Import Generalist only through its released public exports.
- Generalist owns Sessions, Runs, queueing, receipts, retries, cancellation, and execution state.
- Rika owns identity, authorization, Project/Thread metadata, and explicit Runner/Orb placement.
- A product Thread row never starts execution by itself.
- Keep the stable owner/environment/Thread partition and root Session identity deterministic.
- Route HTTP and WebSocket requests through the same authorization and revocation check.

No migration, deployment, release, or compatibility reader belongs here.
