#!/usr/bin/env node
// Node-only Rika Server handshake probe (M1 P1 verification).
// Runs WITHOUT Bun: uses node:crypto HMAC-SHA256 proofs and Node's built-in
// WebSocket client. Usage: node node-handshake.mjs <dataRoot>
// The server must already be running with RIKA_INTERNAL_SERVER_DATA_ROOT=<dataRoot>.
import { createHmac, createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"

const dataRoot = process.argv[2]
if (dataRoot === undefined) {
  console.error("usage: node node-handshake.mjs <dataRoot>")
  process.exit(2)
}

const serverJson = JSON.parse(readFileSync(join(dataRoot, "server.json"), "utf8"))
const token = readFileSync(serverJson.tokenPath, "utf8").trim()
const canonicalRoot = realpathSync(dataRoot)

// Same identity derivation as the server: sha256(profile + "\0" + canonicalDataRoot)
const identity = createHash("sha256").update(`default\0${canonicalRoot}`).digest("hex")
const protocolVersion = 8
const buildIdentity = "rika-development-build"

const hmac = (key, message) => createHmac("sha256", key).update(message).digest("hex")

const clientNonce = crypto.randomUUID()
const clientKind = "web"
const connectRole = "launch"
const signed = { identity, clientNonce, clientKind, connectRole, protocolVersion, buildIdentity }
const clientProof = hmac(
  token,
  JSON.stringify([
    "rika-server-client",
    protocolVersion,
    identity,
    clientNonce,
    clientKind,
    connectRole,
    buildIdentity,
  ]),
)

const url = `ws://127.0.0.1:${serverJson.port}/server`
const socket = new WebSocket(url)
const timeout = setTimeout(() => {
  console.error("handshake timed out")
  process.exit(1)
}, 10_000)

socket.addEventListener("open", () => {
  socket.send(
    JSON.stringify({
      family: "rika-server",
      identity,
      clientNonce,
      clientKind,
      connectRole,
      protocolVersion,
      buildIdentity,
      clientProof,
    }),
  )
})

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data))
  if (message._tag === "accepted") {
    // Verify the server proof with node:crypto only.
    const expectedServerProof = hmac(
      token,
      JSON.stringify([
        "rika-server-response",
        protocolVersion,
        identity,
        clientNonce,
        clientKind,
        connectRole,
        buildIdentity,
        "accepted",
        "accepted",
        "absent",
        message.serviceNonce,
        message.connectionId,
        message.protocolVersion,
        message.buildIdentity,
        message.serverPid ?? "absent",
      ]),
    )
    if (expectedServerProof !== message.serverProof) {
      console.error("server proof verification FAILED")
      console.error("expected:", expectedServerProof)
      console.error("actual:  ", message.serverProof)
      process.exit(1)
    }
    console.log(`handshake accepted (connection ${message.connectionId}, server pid ${message.serverPid})`)
    console.log("server proof verified with node:crypto:", message.serverProof)
    // Ping round-trip proves a live protocol session, not just a socket.
    socket.send(JSON.stringify({ _tag: "ping", id: "node-probe-ping" }))
    return
  }
  if (message._tag === "pong") {
    if (message.id !== "node-probe-ping") {
      console.error("unexpected pong", message)
      process.exit(1)
    }
    console.log("pong received: protocol round-trip OK")
    clearTimeout(timeout)
    socket.close()
    process.exit(0)
  }
  console.error("unexpected server message:", message)
  process.exit(1)
})

socket.addEventListener("error", (event) => {
  console.error("websocket error:", event.message ?? event)
  process.exit(1)
})
