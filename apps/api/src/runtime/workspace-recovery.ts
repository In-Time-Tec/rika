import { ContextMaterializationError } from "@rika/context"
import { tools } from "@rika/execution/tools"
import { Effect, Schema } from "effect"
import type { RunStore, RunTree } from "generalist/runtime"

const unknownToolResult = Schema.TaggedStruct("ToolError", { outcome: Schema.Literal("unknown") })
const rejected = () => ContextMaterializationError.make({
  reason: "binding",
  message: "Workspace recovery requires all earlier native operations to have definite outcomes",
})

const definiteOutcome = ({ run, outcome }: RunTree.TreeRunInspection): boolean => {
  if (!["succeeded", "failed", "cancelled"].includes(run.status)) return false
  const executable = run.executableManifest.entries.find((entry) => entry.pin === run.executableRef.active)
  if (executable?._tag !== "Tool" || !tools.some((tool) => tool.name === executable.manifest.name)) return true
  if (outcome?._tag !== "Succeeded") return false
  const result = outcome.result
  return "_tag" in result && result._tag === "Tool" && !Schema.is(unknownToolResult)(result.value)
}

export const assertWorkspaceRecoverable = ({ store, sessionId, runId }: {
  readonly store: Pick<RunStore.Service, "hostSessionSnapshot" | "hostSessionRunsPage" | "treeCheckpoint">
  readonly sessionId: string
  readonly runId: string
}) => Effect.gen(function* () {
  const session = yield* store.hostSessionSnapshot(sessionId)
  const checked = new Set<string>()
  let before: number | undefined
  for (let pageIndex = 0; pageIndex < 128; pageIndex += 1) {
    const input: Parameters<RunStore.Service["hostSessionRunsPage"]>[1] = { at: session.cursor, limit: 64 }
    if (before !== undefined) Object.assign(input, { before })
    const page = yield* store.hostSessionRunsPage(sessionId, input)
    for (const candidate of page.runs) {
      if (candidate.parentRunId === undefined && candidate.status === "queued") continue
      if (checked.has(candidate.rootRunId)) continue
      checked.add(candidate.rootRunId)
      const checkpoint = yield* store.treeCheckpoint(candidate.rootRunId)
      if (checkpoint.inspection.runs.some((entry) => entry.run.runId !== runId && !definiteOutcome(entry)))
        return yield* rejected()
    }
    if (page.nextBefore === null) return
    if (page.nextBefore === before) return yield* rejected()
    before = page.nextBefore
  }
  return yield* rejected()
}).pipe(Effect.mapError(rejected))
