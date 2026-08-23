import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Crypto, Effect, FileSystem, Layer, Schema } from "effect"
import { testing } from "../src/host"

const packageRoot = new URL("..", import.meta.url).pathname
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const bootstrapProof = `
import { Effect, Redacted } from "effect"
import { createConnection } from "node:net"
import { testing } from "./src/host.ts"
const sandboxId = await Bun.file("/run/e2b/.E2B_SANDBOX_ID").text().then((value) => value.trim()).catch(() => "sandbox-1")
const received = Effect.runPromise(testing.receiveBootstrap)
await Bun.sleep(20)
const hanging = createConnection({ host: "127.0.0.1", port: 7070 })
hanging.on("error", () => {})
await new Promise((resolve) => hanging.once("connect", resolve))
hanging.write(
  "POST /.rika/bootstrap HTTP/1.1\\r\\nHost: 127.0.0.1:7070\\r\\nContent-Type: application/json\\r\\nContent-Length: 100\\r\\nConnection: keep-alive\\r\\n\\r\\n{",
)
const malformed = await Bun.fetch("http://127.0.0.1:7070/.rika/bootstrap", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{",
})
const invalid = await Bun.fetch("http://127.0.0.1:7070/.rika/bootstrap", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential: "must-not-be-consumed" }),
})
const valid = (credential) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    credential,
    identity: {
      target: "orb",
      ownerId: "owner-1",
      threadId: "thread-1",
      assignmentId: "assignment-1",
      assignmentGeneration: 1,
      instanceId: sandboxId,
      executorId: "assignment-1:g1",
      templateBuildId: "build-1",
      apiUrl: "wss://api.example.test/api/v1/executors",
      workspaceId: "workspace-1",
      repository: null,
      lifecycle: "fresh",
      environmentDigest: "sha256:${"a".repeat(64)}",
      setupCache: false,
    },
    restore: null,
  }),
})
const responses = await Promise.all([
  Bun.fetch("http://127.0.0.1:7070/.rika/bootstrap", valid("bootstrap-a")),
  Bun.fetch("http://127.0.0.1:7070/.rika/bootstrap", valid("bootstrap-b")),
])
const accepted = responses.find((response) => response.status === 202)
const body = await accepted.text()
const bootstrap = await received
hanging.destroy()
const credential = Redacted.value(bootstrap.credential)
console.log(
  JSON.stringify({
    malformedStatus: malformed.status,
    invalidStatus: invalid.status,
    statuses: responses.map((response) => response.status).sort(),
    body,
    credential,
    identity: bootstrap.identity,
    restore: bootstrap.restore,
  }),
)
`

const bootstrapIdentityProof = `
const { promise: hello, resolve: resolveHello } = Promise.withResolvers()
const { promise: heartbeat, resolve: resolveHeartbeat } = Promise.withResolvers()
const sandboxId = await Bun.file("/run/e2b/.E2B_SANDBOX_ID").text().then((value) => value.trim()).catch(() => "sandbox-from-bootstrap")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, bunServer) =>
    bunServer.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 }),
  websocket: {
    message: (socket, frame) => {
      const message = JSON.parse(String(frame))
      if (message._tag === "ExecutorHello") {
        resolveHello(message)
        socket.send(JSON.stringify({
          _tag: "ExecutorWelcome",
          welcome: {
            version: 1,
            fence: message.hello.fence,
            sessionToken: "session-token",
            leaseEpoch: 1,
            leaseExpiresAt: Date.now() + 60_000,
            heartbeatIntervalMillis: 20,
            cursor: { sequence: 0, value: "" },
          },
        }))
      } else if (message._tag === "ExecutorHeartbeat") {
        resolveHeartbeat(message)
      }
    },
  },
})
const stateDirectory = "/tmp/rika-bootstrap-identity-" + process.pid
const fileSystem = await import("node:fs/promises")
const host = Bun.spawn(["bun", "run", "./src/host.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    E2B_SANDBOX_ID: "sandbox-from-bootstrap",
    RIKA_EXECUTOR_TARGET: "orb",
    RIKA_EXECUTOR_ASSIGNMENT_ID: "template-readiness",
    RIKA_EXECUTOR_GENERATION: "1",
    RIKA_EXECUTOR_ID: "template-readiness:g1",
    RIKA_EXECUTOR_TEMPLATE_BUILD_ID: "template-readiness",
    RIKA_EXECUTOR_API_URL: "ws://127.0.0.1:1",
    RIKA_EXECUTOR_WORKSPACE_ID: "workspace-readiness",
    RIKA_EXECUTOR_OWNER_ID: "template-owner",
    RIKA_EXECUTOR_THREAD_ID: "template-thread",
    RIKA_EXECUTOR_ENVIRONMENT_DIGEST: "sha256:${"a".repeat(64)}",
    RIKA_EXECUTOR_SETUP_CACHE: "0",
    RIKA_EXECUTOR_STATE_DIRECTORY: stateDirectory,
  },
  stdout: "ignore",
  stderr: "ignore",
})
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const health = await Bun.fetch("http://127.0.0.1:7070/health")
      if (health.ok) break
    } catch {}
    await Bun.sleep(10)
  }
  const response = await Bun.fetch("http://127.0.0.1:7070/.rika/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credential: "one-time-bootstrap",
      identity: {
        target: "orb",
        ownerId: "owner-from-bootstrap",
        threadId: "thread-from-bootstrap",
        assignmentId: "assignment-from-bootstrap",
        assignmentGeneration: 7,
        instanceId: sandboxId,
        executorId: "executor-from-bootstrap",
        templateBuildId: "build-from-bootstrap",
        apiUrl: "ws://127.0.0.1:" + server.port + "/executors",
        workspaceId: "workspace-from-bootstrap",
        repository: null,
        lifecycle: "fresh",
        environmentDigest: "sha256:${"b".repeat(64)}",
        setupCache: false,
      },
      restore: null,
    }),
  })
  const frame = await hello
  const heartbeatFrame = await heartbeat
  console.log(JSON.stringify({ status: response.status, frame, heartbeat: heartbeatFrame }))
} finally {
  host.kill()
  server.stop(true)
  await fileSystem.rm(stateDirectory, { recursive: true, force: true })
}
`

describe.sequential("executor host process", () => {
  it.effect("restores durable operation receipts after host replacement", () =>
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer), (context) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const crypto = yield* Crypto.Crypto
          const directory = `/tmp/rika-operation-receipts-${yield* crypto.randomUUIDv4}`
          const identity = {
            operationKey: "operation-1",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            threadId: "thread-1",
            turnId: "turn-1",
            runId: "run-1",
            rootRunId: "run-1",
            toolCallId: "call-1",
            attempt: 0,
          }
          const frames = new Map([
            [
              "operation-1\u00000",
              [
                { _tag: "Accepted" as const, attribution: identity, cursor: 1 },
                { _tag: "Started" as const, attribution: identity, cursor: 2 },
              ],
            ],
          ])
          const first = yield* testing.operationReceiptStore(directory, "assignment-1", 1)
          yield* first.save(frames)
          const replacement = yield* testing.operationReceiptStore(directory, "assignment-1", 1)
          expect(yield* replacement.load).toEqual(frames)
          const nextGeneration = yield* testing.operationReceiptStore(directory, "assignment-1", 2)
          expect(yield* nextGeneration.load).toEqual(new Map())
          yield* fileSystem.remove(directory, { recursive: true, force: true })
        }).pipe(Effect.provide(context)),
      ),
    ),
  )

  it.effect("flushes the accepted bootstrap response and closes its one-shot listener", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.spawn(["bun", "-e", bootstrapProof], {
          cwd: packageRoot,
          env: { ...process.env, E2B_SANDBOX_ID: "sandbox-1" },
          stdout: "pipe",
          stderr: "pipe",
        }),
      ),
      (child) =>
        Effect.promise(() =>
          Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
        ).pipe(
          Effect.tap(([exitCode, stdout, stderr]) =>
            Effect.sync(() => {
              expect(stderr).toBe("")
              expect(exitCode).toBe(0)
              expect(decodeJson(stdout)).toEqual({
                malformedStatus: 400,
                invalidStatus: 400,
                statuses: [202, 404],
                body: "accepted",
                credential: expect.stringMatching(/^bootstrap-[ab]$/),
                identity: {
                  target: "orb",
                  ownerId: "owner-1",
                  threadId: "thread-1",
                  assignmentId: "assignment-1",
                  assignmentGeneration: 1,
                  instanceId: expect.any(String),
                  executorId: "assignment-1:g1",
                  templateBuildId: "build-1",
                  apiUrl: "wss://api.example.test/api/v1/executors",
                  workspaceId: "workspace-1",
                  repository: null,
                  lifecycle: "fresh",
                  environmentDigest: `sha256:${"a".repeat(64)}`,
                  setupCache: false,
                  stateDirectory: "/var/lib/rika-executor",
                },
                restore: null,
              })
            }),
          ),
          Effect.timeout("5 seconds"),
        ),
      (child) => Effect.sync(() => child.kill()).pipe(Effect.ignore),
    ),
  )

  it.effect(
    "uses the secured bootstrap identity and heartbeats while workspace preparation is blocked",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          Bun.spawn(["bun", "-e", bootstrapIdentityProof], {
            cwd: packageRoot,
            stdout: "pipe",
            stderr: "pipe",
          }),
        ),
        (child) =>
          Effect.promise(() =>
            Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
          ).pipe(
            Effect.tap(([exitCode, stdout, stderr]) =>
              Effect.sync(() => {
                expect(stderr).toBe("")
                expect(exitCode).toBe(0)
                expect(decodeJson(stdout)).toMatchObject({
                  status: 202,
                  frame: {
                    _tag: "ExecutorHello",
                    hello: {
                      fence: {
                        target: "orb",
                        assignmentId: "assignment-from-bootstrap",
                        assignmentGeneration: 7,
                        instanceId: expect.any(String),
                        executorId: expect.stringMatching(/^executor-from-bootstrap:/),
                      },
                      templateBuildId: "build-from-bootstrap",
                      bootstrapToken: "one-time-bootstrap",
                    },
                  },
                  heartbeat: {
                    _tag: "ExecutorHeartbeat",
                    heartbeat: { cursor: { sequence: 0, value: "" } },
                  },
                })
              }),
            ),
            Effect.timeout("15 seconds"),
          ),
        (child) => Effect.sync(() => child.kill()).pipe(Effect.ignore),
      ),
    20_000,
  )
})
