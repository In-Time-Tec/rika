import * as BunPath from "@effect/platform-bun/BunPath"
import { Effect, Layer, Path } from "effect"
import { describe, expect, it } from "vitest"
import { pathContainedIn } from "../../src/policy/workspace-boundary"

/**
 * Containment is no longer a reachability gate. The kernel runs with the Server user's authority
 * and its shell can already reach any path the resolver could refuse, so refusing a workspace tool
 * only pushed the same work onto the unaudited shell. What survives is this predicate, used to keep
 * a directory walk from following a symlink out of the tree it is enumerating, so a search reports
 * results under the root it was asked about and cannot loop.
 */
describe("workspace boundary predicate", () => {
  const path = Effect.scoped(
    Layer.build(BunPath.layer).pipe(Effect.flatMap((context) => Effect.provide(Path.Path, context))),
  ).pipe(Effect.runSync)

  it("accepts paths inside the walked root", () => {
    expect(pathContainedIn("/workspace", "/workspace/src/app.ts", path)).toBe(true)
  })

  it("reports paths that resolve outside the walked root so a walk stops instead of escaping", () => {
    expect(pathContainedIn("/workspace", "/outside/secret.ts", path)).toBe(false)
  })
})
