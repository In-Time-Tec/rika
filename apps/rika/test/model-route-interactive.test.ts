import * as InteractiveEvent from "@rika/product/interactive-event"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as BehaviorMode from "@rika/configuration/behavior-mode"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import { expect, test } from "vitest"

import { createTestRenderer } from "@opentui/core/testing"
import { Cause, Context, Deferred, Effect, Fiber, Layer } from "effect"
import {
  productLayer,
  Service,
  type Interface as OperationServiceInterface,
} from "@rika/product/product-operation-service"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/relay-execution/relay-execution-layer"

import * as ViewState from "@rika/terminal/terminal-state"
import { Surface } from "@rika/terminal/opentui-surface"

import { route as ResidentConfiguration } from "../src/resident/composition/resident-configuration-adapter"

import { modelRouteDisplayLabel, recordingBackend, RouteOperationError } from "./model-script-fixtures"
const { resolveExecutionRouteForSettings } = ResidentConfiguration

test("fails an unavailable tuned route through the typed error channel", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings: SettingsDefaults.ConfigurationSettings = {
        ...SettingsDefaults.Defaults.defaults,
        modes: {
          ...SettingsDefaults.Defaults.defaults.modes,
          low: {
            ...SettingsDefaults.Defaults.defaults.modes.low,
            main: { alias: "fable", effort: "low" },
          },
        },
      }
      const result = yield* Effect.exit(resolveExecutionRouteForSettings(settings, "low", { fastMode: true }))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(Cause.hasDies(result.cause)).toBe(false)
        const failure = result.cause.reasons.find(Cause.isFailReason)
        expect(failure?._tag === "Fail" ? failure.error : undefined).toMatchObject({
          _tag: "ModelRouteError",
          message: expect.stringContaining("Mode low main requests unavailable fable/low/fast variant"),
        })
      }
    }),
  ))

test("surfaces an unavailable tuned route as an interactive execution failure", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Deferred.make<InteractiveSession.InteractiveSession>()
        const release = yield* Deferred.make<void>()
        const events = new Array<InteractiveEvent.InteractiveEvent>()
        const settings: SettingsDefaults.ConfigurationSettings = {
          ...SettingsDefaults.Defaults.defaults,
          modes: {
            ...SettingsDefaults.Defaults.defaults.modes,
            low: {
              ...SettingsDefaults.Defaults.defaults.modes.low,
              main: { alias: "fable", effort: "low" },
            },
          },
        }
        const operationLayer: Layer.Layer<Service, never, never> = productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, recordingBackend([])),
          resolveExecutionRoute: (mode, tuning) =>
            resolveExecutionRouteForSettings(settings, mode, tuning).pipe(
              Effect.map((resolved) => resolved.executionRoute),
              Effect.mapError((error) => RouteOperationError.make({ message: error.message })),
            ),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("route-failure-thread")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("route-failure-turn")),
          interactive: (_, session) =>
            Deferred.succeed(sessions, session).pipe(Effect.andThen(Deferred.await(release))),
        }).pipe(Layer.orDie)
        const operation: OperationServiceInterface = Context.get(
          yield* Layer.buildWithScope(operationLayer, yield* Effect.scope),
          Service,
        )
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(sessions)
        const feed = yield* Effect.forkChild(
          session.events((event: InteractiveEvent.InteractiveEvent) => {
            events.push(event)
          }),
        )
        yield* Effect.yieldNow
        yield* session.submit("unavailable", "low", undefined, { fastMode: true })
        while (!events.some((event) => event._tag === "ExecutionFailed")) yield* Effect.yieldNow
        const failed = events.find((event) => event._tag === "ExecutionFailed")
        expect(failed).toMatchObject({
          _tag: "ExecutionFailed",
          message: expect.stringContaining("Mode low main requests unavailable fable/low/fast variant"),
        })
        yield* Fiber.interrupt(feed)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(operationFiber)
      }),
    ),
  ))

test("renders every default mode route in the mode picker", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const modes = Object.keys(SettingsDefaults.Defaults.defaults.modes) as Array<BehaviorMode.ModeId>
        const setup = yield* Effect.acquireRelease(
          Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 })),
          (value) => Effect.sync(() => value.renderer.destroy()),
        )
        const surface = yield* Effect.acquireRelease(
          Effect.sync(
            () => new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false }),
          ),
          (value) => Effect.sync(() => value.destroy()),
        )
        for (const mode of modes) {
          surface.update({
            ...ViewState.initial("/workspace", mode),
            modePicker: { open: true, selected: modes.indexOf(mode) },
          })
          yield* Effect.tryPromise(() => setup.flush())
          yield* Effect.tryPromise(() => setup.renderOnce())
          const frame = setup.captureCharFrame()
          expect(frame).toContain(
            `Oracle    ${modelRouteDisplayLabel(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, mode, "oracle"))}`,
          )
          expect(frame).toContain(
            `Agent     ${modelRouteDisplayLabel(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, mode, "main"))}`,
          )
        }
      }),
    ),
  ))
