import { Console, Effect, Layer, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { Argument, Command } from "effect/unstable/cli"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { graphFilePath, readGraph, writeGraphs, type GraphArtifact } from "./repository-graph"

type GraphKind = GraphArtifact["graphKind"]
type GraphNode = GraphArtifact["nodes"][number]

const kinds = ["all", "production", "test", "package"] as const
const operations = ["dependencies", "users", "impact", "tests", "why", "graph", "violations", "check"] as const
type QueryOperation = (typeof operations)[number]
type QueryOutput = unknown
class QueryError extends Schema.TaggedErrorClass<QueryError>()("RepositoryGraphQueryError", {
  message: Schema.String,
}) {}

type CheckOutput = {
  readonly subject: string | undefined
  readonly affectedPackages: ReadonlyArray<string>
  readonly rankedTests: ReadonlyArray<string>
  readonly commands: ReadonlyArray<string>
}

const nodeMatches = (node: GraphNode, subject: string) =>
  node.id === subject ||
  node.path === subject ||
  node.id.includes(subject) ||
  (node.path !== undefined && node.path.includes(subject))
const edgeMatches = (graph: GraphArtifact, subject: string | undefined) =>
  subject === undefined
    ? graph.edges
    : graph.edges.filter((edge) => edge.from.includes(subject) || edge.to.includes(subject))
const testRank = (node: GraphNode) => {
  if (node.testKind === "unit-test") return 1
  if (node.testKind === "integration-test" || node.testKind === "contract-test") return 2
  if (node.testKind === "tui-test" || node.testKind === "process-test") return 3
  return 4
}

export const queryGraph = Effect.fn("RepositoryGraph.queryGraph")(function* (
  kind: GraphKind,
  operation: QueryOperation,
  subject?: string,
  inputDirectory = "docs/generated",
): Effect.fn.Return<QueryOutput, Error, FileSystem> {
  const graph = yield* readGraph(kind, inputDirectory)
  const subjectNode = subject === undefined ? undefined : graph.nodes.find((node) => nodeMatches(node, subject))
  if (subject !== undefined && subjectNode === undefined && operation !== "violations")
    return yield* QueryError.make({ message: `query subject is not present in ${kind} graph: ${subject}` })
  if (operation === "graph") return graph
  if (operation === "violations")
    return graph.violations.filter((violation) => subject === undefined || violation.includes(subject))
  const matches = edgeMatches(graph, subject)
  if (operation === "dependencies")
    return matches
      .filter((edge) => subject === undefined || edge.from.includes(subject))
      .map((edge) => edge.to)
      .toSorted()
  if (operation === "users")
    return matches
      .filter((edge) => subject === undefined || edge.to.includes(subject))
      .map((edge) => edge.from)
      .toSorted()
  if (operation === "why") return matches
  if (operation === "tests") {
    return graph.nodes
      .filter((node) => node.testKind !== undefined)
      .filter(
        (node) =>
          subject === undefined || graph.edges.some((edge) => edge.from === node.id && edge.to.includes(subject)),
      )
      .toSorted((a, b) => testRank(a) - testRank(b) || a.id.localeCompare(b.id))
      .map((node) => node.id)
  }
  if (operation === "impact") {
    const impacted = new Set<string>(subject === undefined ? [] : [subjectNode?.id ?? subject])
    let changed = true
    while (changed) {
      changed = false
      for (const edge of graph.edges)
        if (impacted.has(edge.to) && !impacted.has(edge.from)) {
          impacted.add(edge.from)
          changed = true
        }
    }
    return [...impacted].toSorted()
  }
  const impacted = (yield* queryGraph(kind, "impact", subject, inputDirectory)) as ReadonlyArray<string>
  const impactedSet = new Set(impacted)
  const affectedNames = new Set(
    graph.nodes.filter((node) => impactedSet.has(node.id) && node.package !== undefined).map((node) => node.package),
  )
  const packageIds = new Set(
    graph.nodes
      .filter((node) => node.kind === "package" && node.package !== undefined && affectedNames.has(node.package))
      .map((node) => node.id),
  )
  const rankedTests = graph.nodes
    .filter((node) => node.testKind !== undefined)
    .filter((node) => graph.edges.some((edge) => edge.from === node.id && impactedSet.has(edge.to)))
    .toSorted((a, b) => testRank(a) - testRank(b) || a.id.localeCompare(b.id))
    .map((node) => node.id)
  const commands = [...packageIds].toSorted().map((id) => `bun run test-unit -- ${id.slice("package:".length)}`)
  return { subject, affectedPackages: [...packageIds].toSorted(), rankedTests, commands } satisfies CheckOutput
})

const parseQueryArguments = (args: ReadonlyArray<string>) => {
  const values = args.filter((value) => value !== "--")
  const projectionFirst = kinds.includes(values[0] as GraphKind)
  const operation = (projectionFirst ? values[1] : values[0]) as QueryOperation | undefined
  let projection: GraphKind = "all"
  let subject = values[1]
  if (projectionFirst) {
    projection = values[0] as GraphKind
    subject = values[2]
  } else if (kinds.includes(values[1] as GraphKind)) {
    projection = values[1] as GraphKind
    subject = values[2]
  }
  const format = "json"
  if (operation === undefined || !operations.includes(operation))
    throw new Error(`unknown query ${operation ?? "<missing>"}`)
  if (projection === undefined || !kinds.includes(projection as GraphKind))
    throw new Error(`unknown graph projection ${projection ?? "<missing>"}`)
  if (format !== undefined && format !== "json" && format !== "text") throw new Error(`unknown query format ${format}`)
  return { operation, projection: projection as GraphKind, subject, format }
}

const rootPath = Effect.fn("RepositoryGraph.rootPath")(function* () {
  const path = yield* Path
  return path.resolve(import.meta.dirname, "../../..")
})

const printQuery = (value: QueryOutput, format: string | undefined) =>
  format === "text" && typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : JSON.stringify(value, null, 2)

const checkGenerated = Effect.fn("RepositoryGraph.checkGenerated")(function* () {
  const fileSystem = yield* FileSystem
  const path = yield* Path
  const root = path.resolve(import.meta.dirname, "../../..")
  const temporary = yield* fileSystem.makeTempDirectory({ prefix: "rika-repository-graph-" })
  const generated = yield* writeGraphs(root, temporary)
  const comparisons = yield* Effect.all(
    kinds.map((kind) =>
      Effect.gen(function* () {
        const expected = yield* fileSystem.readFileString(path.resolve(root, graphFilePath.resolve(kind)))
        const actual = yield* fileSystem.readFileString(graphFilePath.resolve(kind, temporary))
        return { kind, expected, actual }
      }),
    ),
    { concurrency: "unbounded" },
  )
  const stale = comparisons.find((entry) => entry.expected !== entry.actual)
  if (stale !== undefined)
    return yield* QueryError.make({
      message: `${graphFilePath.resolve(stale.kind)} is stale; run bun --cwd tooling/repository-graph generate`,
    })
  const unresolved = generated.all.violations
  if (unresolved.length > 0) return yield* QueryError.make({ message: unresolved.join("\n") })
  yield* fileSystem.remove(temporary, { recursive: true })
  yield* Console.log("repository graphs are fresh")
})

const main = Effect.fn("RepositoryGraph.main")(function* (args: ReadonlyArray<string>) {
  const root = yield* rootPath()
  const command = args[0]
  if (command === "generate") {
    const path = yield* Path
    yield* writeGraphs(root, path.join(root, "docs/generated"))
    yield* Console.log("generated dependency graph artifacts")
    return
  }
  if (command === "check-generated") {
    yield* checkGenerated()
    return
  }
  if (command === "query") {
    const path = yield* Path
    const parsed = parseQueryArguments(args.slice(1))
    const value = yield* queryGraph(
      parsed.projection,
      parsed.operation,
      parsed.subject,
      path.join(root, "docs/generated"),
    )
    yield* Console.log(printQuery(value, parsed.format))
    return
  }
  return yield* QueryError.make({
    message: "usage: repository-graph-main.ts generate | check-generated | query <operation> [subject]",
  })
})

const command = Command.make("repository-graph", { args: Argument.variadic(Argument.string("argument")) }, ({ args }) =>
  main(args),
)

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer), (context) =>
        Effect.provide(Command.run(command, { version: "0.0.0" }), context),
      ),
    ),
  )

export type { GraphArtifact }
