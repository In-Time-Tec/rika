import { describe, expect, it } from "@effect/vitest"
import { Effect, Path } from "effect"
import * as LocalPath from "@rika/product/local-path"
import { provideLayer } from "../../support/product-layer"

describe("LocalPath product contract", () => {
  it.effect("preserves case-correcting resolution for product context and app paths", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const entries = {
        "/": ["work"],
        "/work": ["src"],
        "/work/src": ["Button.ts"],
      } satisfies Readonly<Record<string, ReadonlyArray<string>>>
      const lookup: LocalPath.Lookup = {
        exists: (candidate) => Effect.succeed(candidate === "/work"),
        readDirectory: (candidate) => Effect.succeed(entries[candidate] ?? []),
      }
      expect(yield* LocalPath.resolveExistingPath(lookup, "SRC/button.ts", { path, base: "/work" })).toBe(
        "/work/src/Button.ts",
      )
    }).pipe(provideLayer(Path.layer)),
  )

  it.effect("keeps missing paths typed", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const lookup: LocalPath.Lookup = {
        exists: () => Effect.succeed(false),
        readDirectory: () => Effect.succeed([]),
      }
      const failure = yield* Effect.flip(LocalPath.resolveExistingPath(lookup, "missing.ts", { path, base: "/work" }))
      expect(failure).toMatchObject({ _tag: "LocalPathError", path: "missing.ts", reason: "not_found" })
    }).pipe(provideLayer(Path.layer)),
  )
})
