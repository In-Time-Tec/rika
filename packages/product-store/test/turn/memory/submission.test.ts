import type { InteractiveSession } from "@rika/product/interactive-session"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ResolvedContext from "@rika/product/context-resolution-service"
import * as ThreadRepository from "@rika/product-store/postgres-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/postgres-turn-repository"
import * as Turn from "@rika/product/turn-record"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import { backend } from "../postgres/repository.fixture"
import { executionSessionLifecycleLayerTest, productLayer, provideLayer } from "../postgres/repository.harness"
import { holdSession, openInteractiveSession, settleEvents } from "../postgres/repository-session.harness"

describe("Operation mention routing", () => {
  it.effect("resolves mentions typed in the composer while ignoring mentions inside pasted text", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const inputs = yield* Ref.make<ReadonlyArray<ResolvedContext.Input>>([])
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
        resolvedContextLayer: ResolvedContext.testLayer({
          resolve: (input) =>
            Ref.update(inputs, (all) => [...all, input]).pipe(Effect.as({ sources: [], diagnostics: [], digest: "" })),
        }),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("pasted-mention-thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("pasted-mention-turn")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, { _tag: "Interactive", prompt: [], ephemeral: false })
        yield* session.submit("review @src/a.ts thanks @Copilot and @ipedro", undefined, [
          { type: "text", text: "review @src/a.ts " },
          { type: "text", text: "thanks @Copilot and @ipedro", pasted: true },
        ])
        yield* settleEvents
      }).pipe(provideLayer(layer))

      expect((yield* Ref.get(inputs)).map((input) => input.references)).toEqual([["src/a.ts"]])
    }),
  )
})
