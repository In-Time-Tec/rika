import { describe, expect, it } from "@effect/vitest"
import { Effect, Path } from "effect"
import * as FileMentions from "../src/file-mentions"
import { provideLayer } from "./layer"

describe("FileMentions", () => {
  it("parses quoted, delimited, empty, and duplicate mentions", () => {
    expect(FileMentions.parse("no mentions")).toEqual([])
    expect(FileMentions.parse(`@'one two.ts', @three.ts; @"four five.ts" @`)).toEqual([
      "one two.ts",
      "three.ts",
      "four five.ts",
    ])
    expect(FileMentions.parse("@plain.ts")).toEqual(["plain.ts"])
  })

  it.effect("resolves, deduplicates, and sorts paths", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      expect(FileMentions.resolve("/work", "@b.ts @a.ts @b.ts", path)).toEqual(["/work/a.ts", "/work/b.ts"])
    }).pipe(provideLayer(Path.layer)),
  )
})
