import * as ModelRouteLabel from "@rika/configuration/model-route-label"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import { expect, test } from "vitest"
import { LanguageModel } from "effect/unstable/ai"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem, Layer, Schema } from "effect"
import * as ViewState from "@rika/terminal/terminal-state"
import type { Model } from "@rika/terminal/terminal-state"
import { Surface } from "@rika/terminal/opentui-surface"
import {
  buildTestModelScript,
  makeReloadingTestModel,
  parseTestModelScript,
} from "@rika/relay-execution/scripted-model-runtime"
import { withBunServices } from "./model-script-fixtures"

test("parses and builds multi-part, object, and delayed TestModel turns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const json = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)([
        {
          parts: [
            { type: "reasoning", text: "inspect" },
            { type: "toolCall", name: "read", params: { path: "a.txt" }, id: "read-1" },
          ],
          delayMs: 25,
          usage: { inputTokens: 7, outputTokens: 3 },
        },
        { parts: [{ type: "text", text: "done" }] },
        { object: { summary: "reviewed", findings: [] }, delayMs: 10 },
      ])
      const parsed = yield* parseTestModelScript(json)
      expect(parsed).toHaveLength(3)
      const built = yield* buildTestModelScript(json)
      expect(built).toEqual([
        {
          _tag: "Turn",
          parts: [
            { _tag: "Reasoning", text: "inspect" },
            { _tag: "ToolCall", name: "read", params: { path: "a.txt" }, id: "read-1", providerExecuted: false },
          ],
          delay: 25,
          usage: {
            inputTokens: { uncached: 7, total: 7, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
        },
        { _tag: "Turn", parts: [{ _tag: "Text", text: "done" }] },
        { _tag: "Object", value: { summary: "reviewed", findings: [] }, delay: 10 },
      ])
    }),
  ))

test("builds a fresh scripted model registration after its source file changes", () =>
  Effect.runPromise(
    Effect.scoped(
      withBunServices(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-reloading-model-" })
          const script = `${root}/script.json`
          yield* fs.writeFileString(script, '[{"parts":[{"type":"text","text":"first"}]}]')
          const fixture = yield* makeReloadingTestModel(script)
          const context = yield* Layer.build(fixture.registration.layer)
          const first = yield* LanguageModel.generateText({ prompt: "first" }).pipe(Effect.provide(context))
          expect(first.text).toBe("first")
          yield* fs.writeFileString(script, '[{"parts":[{"type":"text","text":"second"}]}]')
          const reloadedContext = yield* Layer.build(fixture.registration.layer)
          const second = yield* LanguageModel.generateText({ prompt: "second" }).pipe(Effect.provide(reloadedContext))
          expect(second.text).toBe("second")
        }),
      ),
    ),
  ))

test("rejects malformed, empty, and unsafe scripts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const results = yield* Effect.all(
        [
          "not json",
          "[]",
          '[{"parts":[]}]',
          '[{"parts":[{"type":"toolCall","name":4}]}]',
          '[{"parts":[{"type":"text","text":"x"}],"delayMs":-1}]',
          '[{"parts":[{"type":"text","text":"x"}],"usage":{"inputTokens":-1}}]',
        ].map((value) => Effect.exit(parseTestModelScript(value))),
      )
      expect(results.every((result) => result._tag === "Failure")).toBe(true)
    }),
  ))

test("renders configured model display names in the mode picker", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* Effect.scopedWith((scope) =>
          Layer.buildWithScope(
            ConfigurationService.memoryConfigurationLayer({
              global: {
                modelAliases: {
                  "gate-sonnet": {
                    preset: "claude",
                    provider: "anthropic",
                    candidates: ["claude-sonnet-5"],
                    displayName: "Sonnet 5",
                  },
                  "gate-opus": {
                    preset: "claude",
                    provider: "anthropic",
                    candidates: ["claude-opus-5"],
                    displayName: "Opus 5",
                  },
                },
                modelRoutes: {
                  modes: { high: { main: { alias: "gate-sonnet", effort: "high" }, oracle: "gate-opus" } },
                },
              },
            }),
            scope,
          ).pipe(
            Effect.flatMap((context) => ConfigurationService.effectiveConfiguration().pipe(Effect.provide(context))),
          ),
        )
        const settings = config.settings
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
        surface.update({
          ...ViewState.withModeRouteMap(
            ViewState.initial("/workspace", "high"),
            ModelRouteLabel.modeRouteLabels(settings) as Model["modeRoutes"],
          ),
          modePicker: { open: true, selected: 2 },
        })
        yield* Effect.tryPromise(() => setup.flush())
        yield* Effect.tryPromise(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Agent     Sonnet 5 high")
        expect(frame).toContain("Oracle    Opus 5 high")
        expect(frame).not.toContain("GPT-5.6")
      }),
    ),
  ))
