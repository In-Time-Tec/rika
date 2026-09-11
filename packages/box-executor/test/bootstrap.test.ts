import { expect, it } from "@effect/vitest"
import { toEvidence } from "@rika/execution"
import { Effect, Schema } from "effect"

import { BoxBootstrapDocument, boxBootstrapLockPath, maxBootstrapResponseBytes } from "../src/bootstrap"
import type { BoxTransport } from "../src/provider"
import {
  binding,
  boxId,
  changedBinding,
  changedPaths,
  enrollmentTicket,
  fleetCredential,
  makeAuthority,
  makeService,
  makeTransport,
  paths,
  response,
  stateFor,
  workspacePath,
} from "./support/bootstrap"

it.effect("uses the documented file and command shapes while separating fleet and enrollment credentials", () =>
  Effect.gen(function* () {
    const box = makeTransport()
    const api = makeAuthority()
    const service = makeService(box.transport, api.authority)

    yield* service.enroll(boxId, binding)
    yield* service.enroll(boxId, binding)

    expect(api.issues()).toBe(1)
    expect(box.commands).toHaveLength(1)
    expect(box.requests.map(({ method }) => method)).toEqual(["GET", "PUT", "PUT", "POST", "GET"])
    expect(box.requests[0]?.url).toBe(
      `https://ascii.test/api/box/v1/boxes/${boxId}/files?path=${encodeURIComponent(paths.statePath)}&encoding=utf8`,
    )
    expect(box.requests.slice(1, 3).map(({ url }) => url)).toEqual([
      `https://ascii.test/api/box/v1/boxes/${boxId}/files`,
      `https://ascii.test/api/box/v1/boxes/${boxId}/files`,
    ])
    expect(box.requests[3]?.url).toBe(`https://ascii.test/api/box/v1/boxes/${boxId}/commands`)
    expect(box.requests.every(({ authorization }) => authorization === `Bearer ${fleetCredential}`)).toBe(true)
    expect(
      box.requests
        .filter(({ method }) => method !== "GET")
        .every(({ contentType }) => contentType === "application/json"),
    ).toBe(true)
    expect(box.requests.every(({ body }) => !body.includes(fleetCredential))).toBe(true)

    const document = box.files.get(paths.documentPath)
    expect(document).toBeDefined()
    expect(document).toContain(enrollmentTicket)
    expect(document).not.toContain(fleetCredential)
    if (document === undefined) return yield* Effect.die("Bootstrap document was not written")
    expect(yield* Schema.decodeEffect(Schema.fromJsonString(BoxBootstrapDocument))(document)).toEqual({
      version: 1,
      boxId,
      binding,
      workspacePath,
      enrollment: {
        url: `wss://rika.test/api/v2/boxes/${boxId}/executor`,
        ticket: enrollmentTicket,
        expiresAtMillis: 60_000,
      },
    })
    const command = box.commands[0]
    expect(command).toContain(`exec 9>'${boxBootstrapLockPath}'`)
    expect(command).toContain("flock -n 9 || exit 75")
    expect(command).not.toContain(`mkdir '${boxBootstrapLockPath}'`)
    expect(command).toContain(`exec 3<'${paths.documentPath}'`)
    expect(command).toContain(`rm -f '${paths.documentPath}'`)
    expect(command).toContain("'/opt/rika/bin/runner-v2' 'box' '--bootstrap-stdin' <&3")
    expect(command).not.toContain(enrollmentTicket)
    expect(command).not.toContain(fleetCredential)
    expect(box.files.get(paths.statePath)).not.toContain(enrollmentTicket)
  }),
)

it.effect("initializes a daemon when the live provider reports ENOENT for its exact state path", () =>
  Effect.gen(function* () {
    const box = makeTransport()
    const api = makeAuthority()
    const service = makeService(
      {
        request: (request) =>
          box.transport.request(request).pipe(
            Effect.map((result) =>
              result.status === 404
                ? response(
                    {
                      ok: false,
                      type: "box.error",
                      status: 400,
                      code: "box_direct_failed",
                      message: `ENOENT: no such file or directory, stat '${paths.statePath}'`,
                    },
                    400,
                  )
                : result,
            ),
          ),
      },
      api.authority,
    )

    yield* service.enroll(boxId, binding)
    expect(api.issues()).toBe(1)
    expect(box.commands).toHaveLength(1)
    expect(box.files.get(paths.statePath)).toBe(stateFor("starting"))
  }),
)

it.effect("does not reinterpret another file's ENOENT or a provider failure as absent bootstrap state", () =>
  Effect.forEach(
    [`ENOENT: no such file or directory, stat '${changedPaths.statePath}'`, "Box connection failed"],
    (message) =>
      Effect.gen(function* () {
        const api = makeAuthority()
        const service = makeService(
          {
            request: () =>
              Effect.succeed(
                response({ ok: false, type: "box.error", status: 400, code: "box_direct_failed", message }, 400),
              ),
          },
          api.authority,
        )

        expect(yield* Effect.result(service.enroll(boxId, binding))).toMatchObject({
          _tag: "Failure",
          failure: { phase: "enroll", message: "Box bootstrap state could not be read" },
        })
        expect(api.issues()).toBe(0)
      }),
  ),
)

it.effect("accepts the live provider's home-relative state path without starting another daemon", () =>
  Effect.gen(function* () {
    const api = makeAuthority([undefined, toEvidence(binding)])
    const methods: Array<string> = []
    const service = makeService(
      {
        request: (request) =>
          Effect.sync(() => {
            methods.push(request.method)
            return response({
              ok: true,
              type: "file.read",
              path: `../..${paths.statePath}`,
              content: stateFor("starting"),
            })
          }),
      },
      api.authority,
    )

    yield* service.enroll(boxId, binding)
    expect(yield* service.handshake(boxId, binding)).toEqual(toEvidence(binding))
    expect(methods).toEqual(["GET"])
    expect(api.issues()).toBe(0)
  }),
)

it.effect("rejects another acknowledged state path even when its body carries the admitted binding", () =>
  Effect.gen(function* () {
    const service = makeService(
      {
        request: () =>
          Effect.succeed(
            response({
              ok: true,
              type: "file.read",
              path: `../..${changedPaths.statePath}`,
              content: stateFor("starting"),
            }),
          ),
      },
      makeAuthority().authority,
    )

    expect(yield* Effect.result(service.enroll(boxId, binding))).toMatchObject({
      _tag: "Failure",
      failure: { phase: "enroll", message: "Box bootstrap state acknowledgement changed" },
    })
  }),
)

it.effect("reconciles a lost start acknowledgement from the exact starting marker without redispatch", () =>
  Effect.gen(function* () {
    const box = makeTransport("lost-after-start")
    const api = makeAuthority()
    const service = makeService(box.transport, api.authority)

    yield* service.enroll(boxId, binding)
    yield* service.enroll(boxId, binding)

    expect(api.issues()).toBe(1)
    expect(box.commands).toHaveLength(1)
    expect(box.requests.map(({ method }) => method)).toEqual(["GET", "PUT", "PUT", "POST", "GET", "GET"])
    expect(box.files.get(paths.statePath)).toBe(stateFor("starting"))
  }),
)

it.effect("ignores archived binding state while retaining one process-lifetime lock across generations", () =>
  Effect.gen(function* () {
    const archived = makeTransport()
    const archivedApi = makeAuthority()
    yield* makeService(archived.transport, archivedApi.authority).enroll(boxId, binding)

    const restored = makeTransport("started", changedBinding)
    restored.files.set(paths.statePath, stateFor("starting"))
    restored.files.set(boxBootstrapLockPath, "stale unlocked inode")
    const restoredApi = makeAuthority()
    yield* makeService(restored.transport, restoredApi.authority).enroll(boxId, changedBinding)

    expect(changedPaths.directory).not.toBe(paths.directory)
    expect(restored.requests[0]?.url).toBe(
      `https://ascii.test/api/box/v1/boxes/${boxId}/files?path=${encodeURIComponent(changedPaths.statePath)}&encoding=utf8`,
    )
    expect(restored.files.get(paths.statePath)).toBe(stateFor("starting"))
    expect(restored.files.get(changedPaths.statePath)).toBe(stateFor("starting", changedBinding))
    expect(restoredApi.issues()).toBe(1)

    const archivedCommand = archived.commands[0]
    const restoredCommand = restored.commands[0]
    expect(archivedCommand).toContain(`exec 9>'${boxBootstrapLockPath}'`)
    expect(restoredCommand).toContain(`exec 9>'${boxBootstrapLockPath}'`)
    expect(archivedCommand).toContain("flock -n 9 || exit 75")
    expect(restoredCommand).toContain("flock -n 9 || exit 75")
    expect(archivedCommand).toContain(paths.documentPath)
    expect(restoredCommand).toContain(changedPaths.documentPath)
    expect(restoredCommand).not.toContain(paths.documentPath)

    const contended = makeTransport("lock-contended", changedBinding)
    contended.files.set(paths.statePath, stateFor("starting"))
    const contendedApi = makeAuthority()
    const contendedService = makeService(contended.transport, contendedApi.authority, { readinessAttempts: 1 })
    yield* contendedService.enroll(boxId, changedBinding)
    const notReady = yield* Effect.result(contendedService.handshake(boxId, changedBinding))
    expect(notReady).toMatchObject({
      _tag: "Failure",
      failure: { phase: "handshake", message: "Box Runner did not complete its ready handshake" },
    })
    expect(contended.files.get(changedPaths.statePath)).toBe(stateFor("prepared", changedBinding))
  }),
)

it.effect("polls bounded readiness and returns only the API handshake evidence", () =>
  Effect.gen(function* () {
    const evidence = toEvidence(binding)
    const box = makeTransport()
    box.files.set(paths.statePath, stateFor("starting"))
    const succeeds = makeAuthority([undefined, undefined, evidence])
    const service = makeService(box.transport, succeeds.authority, { readinessAttempts: 3 })

    expect(yield* service.handshake(boxId, binding)).toEqual(evidence)
    expect(succeeds.checks()).toBe(3)

    const bounded = makeAuthority()
    const timeout = makeService(box.transport, bounded.authority, { readinessAttempts: 2 })
    const result = yield* Effect.result(timeout.handshake(boxId, binding))
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { phase: "handshake", message: "Box Runner did not complete its ready handshake" },
    })
    expect(bounded.checks()).toBe(2)
  }),
)

it.effect("fails closed on failed state and changed state or ready fences", () =>
  Effect.gen(function* () {
    const box = makeTransport()
    const api = makeAuthority()
    const service = makeService(box.transport, api.authority)
    box.files.set(paths.statePath, stateFor("failed"))

    const failed = yield* Effect.result(service.enroll(boxId, binding))
    expect(failed).toMatchObject({
      _tag: "Failure",
      failure: { phase: "enroll", message: "Box Runner startup failed" },
    })
    expect(api.issues()).toBe(0)
    expect(box.commands).toHaveLength(0)

    box.files.set(paths.statePath, stateFor("starting", changedBinding))
    const changedState = yield* Effect.result(service.handshake(boxId, binding))
    expect(changedState).toMatchObject({
      _tag: "Failure",
      failure: { phase: "handshake", message: "Box bootstrap state belongs to a changed workspace fence" },
    })

    const changedReady = makeAuthority([toEvidence(changedBinding)])
    const changedService = makeService(box.transport, changedReady.authority)
    const changedEvidence = yield* Effect.result(changedService.handshake(boxId, binding))
    expect(changedEvidence).toMatchObject({
      _tag: "Failure",
      failure: { phase: "handshake", message: "Box ready evidence belongs to a changed workspace fence" },
    })
  }),
)

it.effect("cancels a chunked bootstrap response that exceeds the byte bound", () => {
  let cancelled = false
  const transport: BoxTransport = {
    request: () =>
      Effect.succeed(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(maxBootstrapResponseBytes))
              controller.enqueue(new Uint8Array(1))
            },
            cancel() {
              cancelled = true
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  }
  const api = makeAuthority()
  const service = makeService(transport, api.authority)
  return Effect.gen(function* () {
    const result = yield* Effect.result(service.handshake(boxId, binding))
    expect(result).toMatchObject({ _tag: "Failure", failure: { phase: "handshake" } })
    expect(cancelled).toBe(true)
  })
})
