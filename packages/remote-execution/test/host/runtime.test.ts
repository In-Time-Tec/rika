import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { describe, expect, it } from "@effect/vitest"
import { Context, Crypto, Deferred, Effect, Fiber, Layer, Ref, Semaphore } from "effect"
import { testing } from "../../src/host/service"
import * as HostedKernel from "../../src/host/kernel"
import type { CellLifecycleFrame, CellRequest } from "../../src/protocol/messages"

describe("hosted phase environment", () => {
  it("redacts active secret values from output and terminal responses", () => {
    const secret = "exact-secret-value"
    expect(testing.redactOutput(`before ${secret} after`, [secret])).toEqual({
      text: "before REDACTED after",
      truncated: false,
    })
    expect(
      testing.redactResponse(
        {
          _tag: "Success",
          result: { nested: [secret, `prefix-${secret}`], [secret]: "plain" },
        },
        [secret],
      ),
    ).toEqual({
      _tag: "Success",
      result: { nested: ["REDACTED", "prefix-REDACTED"], REDACTED: "plain" },
    })
  })

  it.effect("keeps phase values in memory and restarts kernels when runtime authorization changes", () =>
    Effect.gen(function* () {
      const grants = yield* Ref.make(new Map())
      const applied = yield* Ref.make(new Map([["session-1", `sha256:${"a".repeat(64)}`]]))
      const access = yield* Semaphore.make(1)
      const environment = { SETUP_TOKEN: "setup-value" }
      const restarts: Array<string> = []
      const executor = {
        admit: () => Effect.die("unused"),
        execute: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        completeBinding: () => Effect.die("unused"),
        replayBindings: () => Effect.die("unused"),
        restart: (sessionId: string) => Effect.sync(() => restarts.push(sessionId)).pipe(Effect.asVoid),
      }
      yield* testing.applyPhaseGrant(
        {
          _tag: "PhaseEnvironmentGranted",
          phase: "runtime",
          digest: `sha256:${"b".repeat(64)}`,
          operationKey: null,
          values: { RUNTIME_TOKEN: "runtime-value" },
          redactedNames: ["RUNTIME_TOKEN"],
        },
        grants,
        environment,
        applied,
        executor,
        access,
      )
      expect(environment).toEqual({ RUNTIME_TOKEN: "runtime-value" })
      expect(restarts).toEqual(["session-1"])
      expect(yield* Ref.get(applied)).toEqual(new Map([["session-1", `sha256:${"b".repeat(64)}`]]))
      expect(yield* Ref.get(grants)).toEqual(new Map())
    }),
  )

  it.effect("admits Orb cell authority before Started can synchronously trigger cancellation", () =>
    Effect.gen(function* () {
      const access = {
        version: 1 as const,
        fence: {
          target: "orb" as const,
          assignmentId: "assignment-readiness",
          assignmentGeneration: 1,
          instanceId: "instance-readiness",
          executorId: "executor-readiness",
          processIncarnation: "process-readiness",
        },
        leaseEpoch: 1,
        sessionToken: "session-readiness",
      }
      const request: CellRequest = {
        access,
        operationKey: "operation-readiness",
        workspaceId: "workspace-readiness",
        sessionId: "session-readiness",
        threadId: "thread-readiness",
        turnId: "turn-readiness",
        runId: "run-readiness",
        rootRunId: "run-readiness",
        toolCallId: "call-readiness",
        code: "mustNotRun()",
        attempt: 0,
        replayPolicy: "never",
        admittedAt: null,
        deadlineAt: "2999-01-01T00:00:00.000Z",
        bindings: {
          digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          descriptors: [],
        },
      }
      const attribution = {
        operationKey: request.operationKey,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        threadId: request.threadId,
        turnId: request.turnId,
        runId: request.runId,
        rootRunId: request.rootRunId,
        toolCallId: request.toolCallId,
        attempt: request.attempt,
      }
      const accepted = { _tag: "Accepted" as const, attribution, cursor: 1 }
      const key = `${request.operationKey}\u0000${request.attempt}`
      const frames = yield* Ref.make(new Map<string, ReadonlyArray<CellLifecycleFrame>>([[key, [accepted]]]))
      let admitted = false
      const cancelled = {
        _tag: "DomainFailure" as const,
        failure: { kind: "cancelled", message: "Cell operation cancelled" },
      }
      const cells = {
        admit: () =>
          Effect.sync(() => {
            admitted = true
          }),
        execute: () => Effect.die("synchronously cancelled Orb cell executed"),
        cancel: () => (admitted ? Effect.succeed(cancelled) : Effect.die("Started preceded Orb cell admission")),
        completeBinding: () => Effect.die("unused"),
        replayBindings: () => Effect.die("unused"),
        restart: () => Effect.die("unused"),
      }
      const append = (_access: CellRequest["access"], frame: CellLifecycleFrame) =>
        Ref.modify(frames, (current) => {
          const retained = current.get(key) ?? []
          if (retained.some((known) => known._tag === "Terminal")) return [false, current] as const
          return [true, new Map(current).set(key, [...retained, frame])] as const
        })
      const emit = (origin: CellRequest["access"], frame: CellLifecycleFrame) =>
        Effect.gen(function* () {
          const appended = yield* append(origin, frame)
          if (frame._tag === "Started")
            yield* testing.cancelCell({
              message: {
                _tag: "CellCancel",
                access,
                operationKey: request.operationKey,
                attempt: request.attempt,
              },
              access,
              frames,
              operations: yield* Ref.make(new Map()),
              cells,
              emit: append,
            })
          return appended
        })

      yield* testing.admitCell({ request, accepted, frames, cells, emit })
      expect(admitted).toBe(true)
      expect(yield* Ref.get(frames)).toEqual(
        new Map([
          [
            key,
            [
              accepted,
              { _tag: "Started", attribution, cursor: 2 },
              { _tag: "Terminal", attribution, cursor: 3, outcome: "cancelled", response: cancelled },
            ],
          ],
        ]),
      )
    }),
  )

  it.effect("keeps the host deadline terminal when CellCancel arrives during terminal persistence", () =>
    Effect.gen(function* () {
      const access = {
        version: 1 as const,
        fence: {
          target: "orb" as const,
          assignmentId: "assignment-1",
          assignmentGeneration: 1,
          instanceId: "instance-1",
          executorId: "executor-1",
          processIncarnation: "process-1",
        },
        leaseEpoch: 1,
        sessionToken: "session-1",
      }
      const operationKey = "operation-timeout"
      const attempt = 0
      const key = `${operationKey}\u0000${attempt}`
      const attribution = {
        operationKey,
        workspaceId: "workspace-1",
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        runId: "run-1",
        rootRunId: "run-1",
        toolCallId: "call-1",
        attempt,
      }
      const timeout = {
        _tag: "DomainFailure" as const,
        failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
      }
      const frames = yield* Ref.make(
        new Map<string, ReadonlyArray<CellLifecycleFrame>>([
          [
            key,
            [
              { _tag: "Accepted", attribution, cursor: 1 },
              { _tag: "Started", attribution, cursor: 2 },
            ],
          ],
        ]),
      )
      const emitted: Array<CellLifecycleFrame> = []
      const emit = (_access: CellRequest["access"], frame: CellLifecycleFrame) =>
        Ref.modify(frames, (current) => {
          const retained = current.get(key) ?? []
          if (retained.some((known) => known._tag === "Terminal")) return [false, current] as const
          emitted.push(frame)
          return [true, new Map(current).set(key, [...retained, frame])] as const
        })
      const releaseTerminal = yield* Deferred.make<void>()
      const terminal = yield* Effect.forkChild(
        Deferred.await(releaseTerminal).pipe(
          Effect.andThen(
            emit(access, { _tag: "Terminal", attribution, cursor: 3, outcome: "failed", response: timeout }),
          ),
        ),
      )
      const cancelStarted = yield* Deferred.make<void>()
      const cancelling = yield* Effect.forkChild(
        testing.cancelCell({
          message: { _tag: "CellCancel", access, operationKey, attempt },
          access,
          frames,
          operations: yield* Ref.make(new Map()),
          cells: {
            admit: () => Effect.die("unused"),
            execute: () => Effect.die("unused"),
            cancel: () => Deferred.succeed(cancelStarted, undefined).pipe(Effect.as(timeout)),
            completeBinding: () => Effect.die("unused"),
            replayBindings: () => Effect.die("unused"),
            restart: () => Effect.die("unused"),
          },
          emit,
        }),
      )
      yield* Deferred.await(cancelStarted)
      yield* Fiber.join(cancelling)
      expect(emitted).toEqual([{ _tag: "Terminal", attribution, cursor: 3, outcome: "failed", response: timeout }])
      expect((yield* Deferred.poll(releaseTerminal))._tag).toBe("None")

      yield* Deferred.succeed(releaseTerminal, undefined)
      yield* Fiber.join(terminal)
      expect(emitted).toHaveLength(1)
      expect(yield* Ref.get(frames)).toEqual(
        new Map([
          [
            key,
            [
              { _tag: "Accepted", attribution, cursor: 1 },
              { _tag: "Started", attribution, cursor: 2 },
              { _tag: "Terminal", attribution, cursor: 3, outcome: "failed", response: timeout },
            ],
          ],
        ]),
      )
    }),
  )

  it.effect("cancels Accepted-only retained Running authority without creating the lazy Orb kernel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "operation-retained"
        const attempt = 0
        const access = {
          version: 1 as const,
          fence: {
            target: "orb" as const,
            assignmentId: "assignment-retained",
            assignmentGeneration: 1,
            instanceId: "instance-retained",
            executorId: "executor-retained",
            processIncarnation: "process-retained",
          },
          leaseEpoch: 1,
          sessionToken: "session-retained",
        }
        const attribution = {
          operationKey,
          workspaceId: "workspace-1",
          sessionId: "session-retained",
          threadId: "thread-retained",
          turnId: "turn-retained",
          runId: "run-retained",
          rootRunId: "run-retained",
          toolCallId: "call-retained",
          attempt,
        }
        const key = `${operationKey}\u0000${attempt}`
        let state: import("../../src/protocol/cells").State = { _tag: "Running", attempt }
        const hosted = yield* HostedKernel.make({
          workspaceIdentity: "workspace-1",
          workspacePath: "/must-not-open",
          dataRoot: "/must-not-open",
          read: () => Effect.sync(() => state),
          write: (_key, value) =>
            Effect.sync(() => {
              state = value
            }),
          sendBinding: () => Effect.die("lazy Orb kernel started during retained cancellation"),
        })
        const frames = yield* Ref.make(
          new Map<string, ReadonlyArray<CellLifecycleFrame>>([[key, [{ _tag: "Accepted", attribution, cursor: 1 }]]]),
        )
        expect(testing.machineParentActive(yield* Ref.get(frames), operationKey, attempt)).toBe(true)
        const machineInterrupted = yield* Deferred.make<void>()
        const machine = yield* Effect.forkChild(
          Effect.never.pipe(Effect.ensuring(Deferred.succeed(machineInterrupted, undefined)), Effect.asVoid),
          { startImmediately: true },
        )
        const operations = yield* Ref.make<Map<string, Fiber.Fiber<void, unknown>>>(
          new Map([[`${key}\u0000machine-1`, machine]]),
        )
        const emit = (_access: CellRequest["access"], frame: CellLifecycleFrame) =>
          Effect.gen(function* () {
            if (frame._tag === "Terminal") yield* Deferred.await(machineInterrupted)
            return yield* Ref.modify(frames, (current) => {
              const retained = current.get(key) ?? []
              return [true, new Map(current).set(key, [...retained, frame])] as const
            })
          })

        yield* testing.cancelCell({
          message: { _tag: "CellCancel", access, operationKey, attempt },
          access,
          frames,
          operations,
          cells: hosted,
          emit,
        })
        expect((yield* Deferred.poll(machineInterrupted))._tag).toBe("Some")
        expect(testing.machineParentActive(yield* Ref.get(frames), operationKey, attempt)).toBe(false)
        const terminal = (yield* Ref.get(frames)).get(key)?.at(-1)
        const response = terminal?._tag === "Terminal" ? terminal.response : undefined
        expect(response).toEqual({
          _tag: "DomainFailure",
          failure: { kind: "cancelled", message: "Cell operation cancelled" },
        })
        expect(state).toEqual({ _tag: "Completed", attempt, response })
        expect(yield* Ref.get(frames)).toEqual(
          new Map([
            [
              key,
              [
                { _tag: "Accepted", attribution, cursor: 1 },
                { _tag: "Terminal", attribution, cursor: 2, outcome: "cancelled", response },
              ],
            ],
          ]),
        )
      }),
    ).pipe(
      Effect.provideServiceEffect(
        Crypto.Crypto,
        Effect.scoped(Layer.build(BunCrypto.layer)).pipe(Effect.map((context) => Context.get(context, Crypto.Crypto))),
      ),
    ),
  )
})
