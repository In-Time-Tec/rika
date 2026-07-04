import { describe, expect, test } from "bun:test"
import { Common } from "@rika/schema"
import { parseThreadSearchQuery, resolveDateFilter } from "../src/thread-search-query"

describe("Thread search query parser", () => {
  test("parses text terms, quoted phrases, and filters", () => {
    expect(
      parseThreadSearchQuery(
        'auth "race fix" file:src/**/*.ts after:7d before:2026-07-01 archived:false project:backend',
      ),
    ).toEqual({
      terms: ["auth", "race fix"],
      file_globs: ["src/**/*.ts"],
      after: { _tag: "relative", amount: 7, unit: "d" },
      before: { _tag: "absolute", value: "2026-07-01" },
      archived: false,
      project: "backend",
    })
  })

  test("keeps repeated file filters and de-duplicates text terms", () => {
    expect(parseThreadSearchQuery("auth auth file:src/auth.ts file:packages/**/*.ts")).toEqual({
      terms: ["auth"],
      file_globs: ["src/auth.ts", "packages/**/*.ts"],
    })
  })

  test("resolves relative and ISO date filters against the supplied clock", () => {
    const now = Common.TimestampMillis.make(Date.UTC(2026, 6, 4, 12))

    expect(resolveDateFilter({ _tag: "relative", amount: 24, unit: "h" }, now)).toBe(
      Common.TimestampMillis.make(Date.UTC(2026, 6, 3, 12)),
    )
    expect(resolveDateFilter({ _tag: "absolute", value: "2026-07-01" }, now)).toBe(
      Common.TimestampMillis.make(Date.UTC(2026, 6, 1)),
    )
  })
})
