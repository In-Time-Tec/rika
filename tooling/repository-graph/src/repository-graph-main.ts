import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { graphFilePath, readGraph, writeGraphs, type GraphArtifact, type GraphKind } from "./repository-graph"

const kinds = ["all", "production", "test", "package"] as const
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

const query = async (kind: GraphKind, operation: string, subject?: string) => {
  const graph = await readGraph(kind)
  const edges = graph.edges
  if (operation === "graph") return graph
  if (operation === "violations") return graph.violations
  if (operation === "check")
    return graph.violations.filter((violation) => subject === undefined || violation.startsWith(subject))
  const matches =
    subject === undefined
      ? edges
      : edges.filter(
          (edge) =>
            edge.from === subject || edge.to === subject || edge.from.includes(subject) || edge.to.includes(subject),
        )
  if (operation === "dependencies")
    return matches.filter((edge) => edge.from === subject || edge.from.includes(subject ?? "")).map((edge) => edge.to)
  if (operation === "users")
    return matches.filter((edge) => edge.to === subject || edge.to.includes(subject ?? "")).map((edge) => edge.from)
  if (operation === "tests")
    return edges
      .filter((edge) => edge.from.endsWith(".test.ts") || edge.from.includes("/test/"))
      .filter((edge) => subject === undefined || edge.to === subject || edge.to.includes(subject))
      .map((edge) => edge.from)
  if (operation === "why") return matches
  if (operation === "impact") {
    const impacted = new Set<string>(subject ? [subject] : [])
    let changed = true
    while (changed) {
      changed = false
      for (const edge of edges)
        if (impacted.has(edge.to) && !impacted.has(edge.from)) {
          impacted.add(edge.from)
          changed = true
        }
    }
    return [...impacted].toSorted()
  }
  throw new Error(`unknown query ${operation}`)
}

const checkGenerated = async () => {
  const directory = await mkdtemp(join(tmpdir(), "rika-repository-graph-"))
  try {
    await writeGraphs(directory)
    const comparisons = await Promise.all(
      kinds.map(
        async (kind) =>
          [
            await readFile(graphFilePath(kind), "utf8"),
            await readFile(graphFilePath(kind, directory), "utf8"),
          ] as const,
      ),
    )
    const stale = comparisons.findIndex(([expected, actual]) => expected !== actual)
    if (stale !== -1)
      throw new Error(
        `${graphFilePath(kinds[stale] ?? "all")} is stale; run bun --cwd tooling/repository-graph generate`,
      )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  process.stdout.write("repository graphs are fresh\n")
}

const main = async (args: ReadonlyArray<string>) => {
  const [command, ...rest] = args
  if (command === "generate") {
    await writeGraphs()
    process.stdout.write("generated dependency graph artifacts\n")
    return
  }
  if (command === "check-generated") {
    await checkGenerated()
    return
  }
  if (command === "query") {
    const [operation, subject] = rest
    const kind = operation === "check" ? "all" : "all"
    print(await query(kind, operation ?? "graph", subject))
    return
  }
  throw new Error("usage: repository-graph-main.ts generate | check-generated | query <operation> [subject]")
}

const command = Command.make("repository-graph", { args: Argument.variadic(Argument.string("argument")) }, ({ args }) =>
  Effect.promise(() => main(args)),
)

if (import.meta.main) {
  process.chdir(resolve(import.meta.dirname, "../../.."))
  BunRuntime.runMain(Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(BunServices.layer)))
}

export type { GraphArtifact }
