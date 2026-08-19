import { Config, Effect } from "effect"

const identity = await Effect.runPromise(
  Config.string("RIKA_TEST_BUILD_IDENTITY").pipe(Config.withDefault("rika-test-other-build")),
)
;(globalThis as Record<string, unknown>).RIKA_BUILD_IDENTITY = identity
await import("./server-client")
