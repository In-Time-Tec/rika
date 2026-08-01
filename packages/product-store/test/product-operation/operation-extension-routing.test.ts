import { Service } from "@rika/product/product-operation-service"
import { reconcile } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as PluginRegistry from "@rika/extensions/plugin-registry"
import { Effect, Layer, Ref } from "effect"

import { executionRoute } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { reconcileDependencies } from "../support/operation-session-harness"
import { executionStarted, backend } from "../support/operation-execution-fixtures"

import { turnProvenance, threadLineage } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("pins new executions, resumes pinned executions, and drains multiple queued turns", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("extension-thread"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Extensions",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const pin: ExecutionExtensions.Pin = {
        generation: "generation",
        sourceDigest: "source",
        configFingerprint: "config",
        toolSchemaDigest: "tools",
        mcpFingerprint: "mcp",
        resolvedContextDigest: "context",
      }
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("queued-one"),
          threadId: thread.id,
          prompt: "one",
          promptParts: [
            { type: "text", text: "one " },
            { type: "image", mediaType: "image/png", data: "cG5n", filename: "probe.png" },
          ],
          ...turnProvenance,
          executionRoute: executionRoute(),
          status: "queued",
          stopIntent: "none",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: Turn.TurnId.make("queued-two"),
          threadId: thread.id,
          prompt: "two",
          ...turnProvenance,
          executionRoute: executionRoute(),
          status: "queued",
          stopIntent: "none",
          createdAt: 3,
          updatedAt: 3,
          extensionPin: pin,
        },
      ])
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const generation: PluginRegistry.Generation = {
        id: "generation",
        sourceDigest: "source",
        configFingerprint: "config",
        toolSchemaDigest: "tools",
        tools: new Map(),
        modes: new Map(),
        agentProfiles: new Map(),
        uiActions: new Map(),
        diagnostics: [],
      }
      const extensions = ExecutionExtensions.ExecutionExtensionService.of({
        future: () => Ref.update(calls, (all) => [...all, "future"]).pipe(Effect.as({ pin, generation })),
        resume: (value) =>
          Ref.update(calls, (all) => [...all, `resume:${value.generation}`]).pipe(
            Effect.as({ pin: value, generation }),
          ),
      })
      const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
      const runBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (all) => [...all, input]).pipe(
            Effect.as({
              turnId: input.turnId,
              status: "completed" as const,
              events: [
                executionStarted(String(input.turnId)),
                {
                  executionId: String(input.turnId),
                  cursor: `${input.turnId}-answer`,
                  sequence: 1,
                  type: "model.output.completed",
                  createdAt: 1,
                  text: "answer",
                },
                {
                  executionId: String(input.turnId),
                  cursor: `${input.turnId}-completed`,
                  sequence: 2,
                  type: "execution.completed",
                  timestampSource: "server",
                  createdAt: 2,
                },
              ],
            }),
          ),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({
          _tag: "Run",
          prompt: ["initial"],
          threadId: thread.id,
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, runBackend),
            executionExtensions: {
              layer: Layer.succeed(ExecutionExtensions.ExecutionExtensionService, extensions),
              mcpFingerprint: Effect.succeed("mcp"),
            },
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("initial")),
          }),
        ),
      )
      const started = yield* Ref.get(starts)
      expect(started.map((value) => value.turnId)).toEqual(["queued-one", "queued-two", "initial"])
      expect(started[0]?.promptParts).toEqual([
        { type: "text", text: "one " },
        { type: "image", mediaType: "image/png", data: "cG5n", filename: "probe.png" },
      ])
      expect(yield* Ref.get(calls)).toEqual(["future", "resume:generation", "future"])
    }),
  )

  it.effect("maps extension resume failures and prints empty completed output", () =>
    Effect.gen(function* () {
      const pin: ExecutionExtensions.Pin = {
        generation: "missing",
        sourceDigest: "s",
        configFingerprint: "c",
        toolSchemaDigest: "t",
        mcpFingerprint: "m",
        resolvedContextDigest: "r",
      }
      const extensions = ExecutionExtensions.ExecutionExtensionService.of({
        future: () => Effect.die("unused"),
        resume: () => Effect.fail(PluginRegistry.GenerationUnavailable.make({ generation: "missing" })),
      })
      const run = (resumeFails: boolean) =>
        Effect.gen(function* () {
          const operation = yield* Service
          return yield* Effect.result(
            operation.run({
              _tag: "Run",
              prompt: [],
              ephemeral: false,
              streamJson: false,
              streamJsonInput: false,
              streamJsonThinking: false,
            }),
          )
        }).pipe(
          provideLayer(
            productLayer({
              repositoryLayer: ThreadRepository.memoryLayer(),
              turnRepositoryLayer: TurnRepository.memoryLayer(),
              backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
              defaultWorkspace: "/work",
              makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
              makeTurnId: Effect.succeed(Turn.TurnId.make("turn")),
              ...(resumeFails
                ? {
                    executionExtensions: {
                      layer: Layer.succeed(ExecutionExtensions.ExecutionExtensionService, extensions),
                      mcpFingerprint: Effect.succeed("m"),
                    },
                  }
                : {}),
            }),
          ),
        )
      expect((yield* run(false))._tag).toBe("Success")
      const existing = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active-pin"),
          ...turnProvenance,
          threadId: Thread.ThreadId.make("thread"),
          prompt: "resume",
          executionRoute: executionRoute(),
          status: "running",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
          extensionPin: pin,
        },
      ])
      const failure = yield* reconcile(extensions).pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(extensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, existing),
            Layer.succeed(ExecutionBackend.Service, {
              ...backend,
              inspect: () => Effect.void.pipe(Effect.as(undefined)),
            }),
          ),
        ),
        Effect.result,
      )
      expect(failure._tag).toBe("Failure")
    }),
  )

  it.effect("reconciles a current missing execution with its pinned extension state", () =>
    Effect.gen(function* () {
      const pin: ExecutionExtensions.Pin = {
        generation: "g",
        sourceDigest: "s",
        configFingerprint: "c",
        toolSchemaDigest: "t",
        mcpFingerprint: "m",
        resolvedContextDigest: "r",
      }
      const generation: PluginRegistry.Generation = {
        id: "g",
        sourceDigest: "s",
        configFingerprint: "c",
        toolSchemaDigest: "t",
        tools: new Map(),
        modes: new Map(),
        agentProfiles: new Map(),
        uiActions: new Map(),
        diagnostics: [],
      }
      const extensions = ExecutionExtensions.ExecutionExtensionService.of({
        future: () => Effect.die("unused"),
        resume: (value) => Effect.succeed({ pin: value, generation }),
      })
      const pinned = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("pinned"),
          ...turnProvenance,
          threadId: Thread.ThreadId.make("thread"),
          prompt: "resume",
          executionRoute: executionRoute(),
          status: "running",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 2,
          extensionPin: pin,
          lastCursor: "old",
        },
      ])
      yield* reconcile(extensions).pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(extensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, pinned),
            Layer.succeed(ExecutionBackend.Service, {
              ...backend,
              inspect: () => Effect.void.pipe(Effect.as(undefined)),
              start: (input) => Effect.succeed({ turnId: input.turnId, status: "completed", events: [] }),
            }),
          ),
        ),
      )
      expect(yield* pinned.get(Turn.TurnId.make("pinned"))).toMatchObject({ status: "completed", lastCursor: "old" })
    }),
  )
})
