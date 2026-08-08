# @rika/client

The browser + Bun WebSocket protocol client for Rika Server. Owns the client
transport (connection, session, feed, reconnect) and the shared wire protocol
(codecs + handshake helpers) used by both clients and the server.

- `connection.ts` — handshake, frames, ping, cancel, operation requests. The
  WebSocket constructor is taken from the Effect context (`Socket.WebSocketConstructor`):
  provide `BunSocket.layerWebSocketConstructor` (CLI/Bun) or
  `Socket.layerWebSocketConstructorGlobal` (browser).
- `session.ts` — interactive session (Submit/Steer/Cancel/Approve/Deny/...).
- `feed.ts` — ThreadView snapshot/patch consume + acks + resync.
- `reconnect.ts` — reconnect + resync.
- `protocol/*` — the wire protocol (server-protocol, server-message-codec,
  server-protocol-handshake). Shared with `apps/server`.

Grep gate: no `bun:`/`node:` imports in `src` — platform bits are injected layers.
