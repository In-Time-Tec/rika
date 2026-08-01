import { Effect, Layer } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, test } from "vitest"
import { readGraph, type GraphArtifact } from "./repository-graph"
import { queryGraph } from "./repository-graph-main"

type GraphKind = GraphArtifact["graphKind"]
const kinds: ReadonlyArray<GraphKind> = ["all", "production", "test", "package"]

describe("repository graph artifacts", () => {
  test("supports graph queries over generated projections", () => {
    const program = Effect.gen(function* () {
      const dependencies = yield* queryGraph("package", "dependencies", "package:@rika/product")
      expect(dependencies).toContain("package:@rika/configuration")
      expect(yield* queryGraph("all", "violations")).toEqual([])
      expect(yield* queryGraph("all", "check", "packages/product/src/operation/contract/product-operation.ts")).toEqual(
        expect.objectContaining({ affectedPackages: expect.any(Array), commands: expect.any(Array) }),
      )
    })
    return Effect.runPromise(
      Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
    )
  })

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
