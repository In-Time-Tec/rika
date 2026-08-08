import { cruise } from "dependency-cruiser"
import { Effect, Schema } from "effect"
import { describe, expect, test } from "vitest"

class SpikeError extends Schema.TaggedErrorClass<SpikeError>()("DependencyCruiserSpikeError", {
  message: Schema.String,
}) {}

describe("dependency-cruiser compatibility spike", () => {
  test("parses Effect syntax, workspace imports, prompt assets, and unit edges", () =>
    Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          cruise(
            ["tooling/repository-graph/test/fixtures/dependency-cruiser-spike/bun-workspace.ts"],
            { doNotFollow: { path: ".*" } },
            undefined,
            { tsConfig: { module: "ESNext", moduleResolution: "Bundler" } },
          ),
        catch: (error) => SpikeError.make({ message: String(error) }),
      }).pipe(
        Effect.flatMap((result) => {
          if (typeof result.output === "string") return Effect.fail(SpikeError.make({ message: result.output }))
          const module = result.output.modules[0]
          return Effect.sync(() => {
            expect(module?.dependencies.map((dependency) => dependency.module).toSorted()).toEqual([
              "./prompt.prompt.txt",
              "@rika/config/canonical-data-root",
              "effect",
            ])
            expect(
              module?.dependencies.find((dependency) => dependency.module === "./prompt.prompt.txt")?.couldNotResolve,
            ).toBe(false)
            expect(
              module?.dependencies.find((dependency) => dependency.module === "@rika/config/canonical-data-root")
                ?.couldNotResolve,
            ).toBe(true)
          })
        }),
      ),
    ))
})
