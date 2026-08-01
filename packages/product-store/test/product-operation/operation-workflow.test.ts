import type { Input } from "@rika/product/product-operation"
import { Service } from "@rika/product/product-operation-service"
import { testLayer } from "@rika/product/product-operation-service"
import { unavailableLayer } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Effect, Layer, Ref } from "effect"
import { TestConsole } from "effect/testing"

import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { backend } from "../support/operation-execution-fixtures"

import { replacementWorkflow } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("records operations through the test layer", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Input>>([])
      yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({ _tag: "Doctor" })
      }).pipe(provideLayer(testLayer(calls)))
      expect(yield* Ref.get(calls)).toEqual([{ _tag: "Doctor" }])
    }),
  )

  it.effect("reports unavailable operations as expected failures", () =>
    Effect.gen(function* () {
      const operation = yield* Service
      const unavailable = yield* Effect.result(operation.run({ _tag: "Doctor" }))
      const run = yield* Effect.result(
        operation.run({
          _tag: "Run",
          prompt: ["hello"],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        }),
      )
      expect(unavailable._tag).toBe("Failure")
      expect(run._tag).toBe("Failure")
    }).pipe(provideLayer(unavailableLayer)),
  )

  it.effect("starts, inspects, cancels, and reports missing workflow runs", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const workflowBackend = ExecutionBackend.Service.of({
        ...backend,
        registerWorkflows: () => Ref.update(calls, (values) => [...values, "register"]).pipe(Effect.as([])),
        startWorkflow: (name, runId, revision, _ownerTurnId, workspace) =>
          Ref.update(calls, (values) => [...values, `start:${name}:${runId}:${revision}:${workspace}`]).pipe(
            Effect.as({
              runId,
              workflow: name,
              revision: revision ?? 1,
              digest: "digest",
              status: "running" as const,
              createdAt: 1,
              updatedAt: 1,
            }),
          ),
        inspectWorkflow: (runId, _ownerTurnId, workspace) =>
          Ref.update(calls, (values) => [...values, `inspect:${runId}:${workspace}`]).pipe(
            Effect.as(
              runId === "missing"
                ? undefined
                : {
                    runId,
                    workflow: "delivery",
                    revision: 2,
                    digest: "digest",
                    status: "completed" as const,
                    createdAt: 1,
                    updatedAt: 2,
                  },
            ),
          ),
        cancelWorkflow: (runId, _ownerTurnId, workspace) =>
          Ref.update(calls, (values) => [...values, `cancel:${runId}:${workspace}`]).pipe(
            Effect.as(
              runId === "missing"
                ? undefined
                : {
                    runId,
                    workflow: "delivery",
                    revision: 2,
                    digest: "digest",
                    status: "cancelled" as const,
                    createdAt: 1,
                    updatedAt: 3,
                  },
            ),
          ),
      })
      const layer = Layer.merge(
        TestConsole.layer,
        productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, workflowBackend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("unused"),
          makeTurnId: Effect.die("unused"),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({
          _tag: "Workflow",
          action: "start",
          name: "delivery",
          runId: "run",
          revision: 2,
          clientWorkspace: "/client-work",
        })
        yield* operation.run({ _tag: "Workflow", action: "inspect", runId: "run", clientWorkspace: "/client-work" })
        yield* operation.run({ _tag: "Workflow", action: "cancel", runId: "run", clientWorkspace: "/client-work" })
        return yield* Effect.result(
          operation.run({ _tag: "Workflow", action: "inspect", runId: "missing", clientWorkspace: "/client-work" }),
        )
      }).pipe(provideLayer(layer))
      expect(output._tag).toBe("Failure")
      expect(yield* Ref.get(calls)).toEqual([
        "register",
        "start:delivery:run:2:/client-work",
        "inspect:run:/client-work",
        "cancel:run:/client-work",
        "inspect:missing:/client-work",
      ])
    }),
  )

  it.effect("defers replacement for a running workflow and authorizes retry after Relay reports terminal", () =>
    Effect.gen(function* () {
      const status = yield* Ref.make<ExecutionBackend.WorkflowInspection["status"]>("running")
      const workflowBackend = ExecutionBackend.Service.of({
        ...backend,
        registerWorkflows: () => Effect.succeed([]),
        startWorkflow: () => Ref.get(status).pipe(Effect.map(replacementWorkflow)),
        inspectWorkflow: () => Ref.get(status).pipe(Effect.map(replacementWorkflow)),
      })
      const layer = Layer.merge(
        TestConsole.layer,
        productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, workflowBackend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("unused"),
          makeTurnId: Effect.die("unused"),
        }),
      )
      yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({
          _tag: "Workflow",
          action: "start",
          name: "delivery",
          runId: "replacement-workflow",
          clientWorkspace: "/work",
        })
        expect(yield* operation.authorizeResidentReplacement!).toBe("defer")
        yield* Ref.set(status, "completed")
        expect(yield* operation.authorizeResidentReplacement!).toBe("supersede")
      }).pipe(provideLayer(layer))
    }),
  )

  it.effect("reconciles an absent workflow and retries replacement after workflow inspection errors", () =>
    Effect.gen(function* () {
      const inspection = yield* Ref.make<"error" | "absent">("error")
      const workflowBackend = ExecutionBackend.Service.of({
        ...backend,
        registerWorkflows: () => Effect.succeed([]),
        startWorkflow: () => Effect.succeed(replacementWorkflow("running")),
        inspectWorkflow: () =>
          Ref.get(inspection).pipe(
            Effect.flatMap((current) =>
              current === "error"
                ? Effect.fail(ExecutionBackend.BackendError.make({ message: "workflow inspection failed" }))
                : Effect.void.pipe(Effect.as(undefined)),
            ),
          ),
      })
      const layer = Layer.merge(
        TestConsole.layer,
        productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, workflowBackend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("unused"),
          makeTurnId: Effect.die("unused"),
        }),
      )
      yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({
          _tag: "Workflow",
          action: "start",
          name: "delivery",
          runId: "replacement-workflow",
          clientWorkspace: "/work",
        })
        expect((yield* Effect.result(operation.authorizeResidentReplacement!))._tag).toBe("Failure")
        yield* Ref.set(inspection, "absent")
        expect(yield* operation.authorizeResidentReplacement!).toBe("supersede")
      }).pipe(provideLayer(layer))
    }),
  )
})
