import { Effect, Layer } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, test } from "vitest"
import { readGraph, type GraphKind } from "./repository-graph"

const kinds: ReadonlyArray<GraphKind> = ["all", "production", "test", "package"]

describe("repository graph artifacts", () => {
  test("use the schema contract and closed projections", () => {
    const program = Effect.gen(function* () {
      for (const kind of kinds) {
        const graph = yield* readGraph(kind)
        const nodes = new Set(graph.nodes.map((node) => node.id))
        expect(graph.schemaVersion).toBe(1)
        expect(graph.edges.every((edge) => nodes.has(edge.from) && nodes.has(edge.to))).toBe(true)
        expect(graph.nodes.every((node) => node.publicExports !== undefined && node.production !== undefined)).toBe(
          true,
        )
        expect(graph.edges.every((edge) => ["runtime", "type", "test", "asset"].includes(edge.relationship))).toBe(true)
      }
    })
    return Effect.runPromise(
      Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
    )
  })
})
