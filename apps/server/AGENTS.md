# @rika/server

Owns the standalone Rika Server: the `server-main` entry, the Bun HTTP/WebSocket host
(`transport/host`), the wire protocol codecs (`@rika/client/protocol`) shared with clients,
the server process lifecycle and spawn contract (`server/process`), the server composition
(`server/composition`), the OpenAI device-code auth adapter (`provider/openai`), and the
server's process logging and version constants (`diagnostics`, `platform`).

`apps/cli` (and, later, `apps/desktop`) depend on `@rika/server` only for the spawn
contract: `server-process-spawn`, `server-process`, `server-endpoint`, `server-startup`,
`diagnostic-file-logging`, and `application-version`. The wire protocol codecs live in
`@rika/client/protocol`; the server imports them from there. Everything else in this
package is server-process code and must never be imported by a client.

The packaged layout ships the server as a sibling `rika-server` binary (`.rika-server`
beside `rika`); in development the CLI spawns `apps/server/src/server-main.ts` with
`bun`. The server never imports from `@rika/cli`.
