# Rika API

This is the Rika API composition: identity, authorization, Project/Thread product metadata, explicit Runner/Orb
placement, and the Runner/Box execution gateways. It delegates durable execution to released Generalist 0.65.3.

- Import Generalist only through its released public exports.
- Generalist owns Sessions, Runs, queueing, receipts, retries, cancellation, and execution recovery. Durable object
  state lives in `generalist/durability/s3`; `generalist/unstable/rivet` is only the scoped Runtime host.
- PostgreSQL is product and identity persistence only — never a second execution journal.
- Rika owns identity, authorization, Project/Thread metadata, and explicit Runner/Orb placement.
- A product Thread row never starts execution by itself.
- Keep the stable owner/environment/Thread partition and root Session identity deterministic.
- Route HTTP and WebSocket requests through the same authorization and revocation check.
- `/api/rivet` and descendants go to the registry handler. Readiness is `/api/rivet/metadata`; `/healthz` is a
  fixed response only and must not be used as readiness. There is no `/readyz`.
- `src/main.ts` is the production entrypoint; `src/database/migrate.ts` runs identity and product migrations.
