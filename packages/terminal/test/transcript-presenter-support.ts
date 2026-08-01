import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"

import { applyChildUnits, applyTurnUnits } from "../src/presentation/transcript/terminal-transcript-presentation"
import { attachChildProjections } from "../src/presentation/transcript/transcript-attachment"
import { type Entry } from "../src/state/model/terminal-message"
import { initial, type Model } from "../src/state/model/terminal-state"
import { type TranscriptItem } from "../src/state/model/terminal-transcript-state"

import { agentResponseState } from "../src/presentation/transcript/transcript-agent-response"

const event = (
  cursor: string,
  sequence: number,
  type: string,
  fields: Partial<TranscriptSourceEvent.SourceEvent> = {},
): TranscriptSourceEvent.SourceEvent => ({ cursor, sequence, type, createdAt: sequence, ...fields })

const parentProjection = TranscriptProjection.Projection.project("turn", "prompt", [
  event("assistant-0", 0, "model.output.completed", { text: "Working on it." }),
  event("agent", 1, "tool.call.requested", {
    data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review the code" } },
  }),
  event("agent-spawned", 2, "child_run.spawned", {
    data: { tool_call_id: "agent", child_execution_id: "child:turn:oracle" },
  }),
])

const childProjection = TranscriptProjection.Projection.project("child:turn:oracle", "", [
  event("read", 0, "tool.call.requested", {
    data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
  }),
  event("read-result", 1, "tool.result.received", { data: { tool_call_id: "read", output: "contents" } }),
  event("nested-agent", 2, "tool.call.requested", {
    data: { tool_call_id: "nested", tool_name: "task", input: { prompt: "Dig deeper" } },
  }),
  event("nested-spawned", 3, "child_run.spawned", {
    data: { tool_call_id: "nested", child_execution_id: "child:child:turn:oracle:nested" },
  }),
])

const grandchildProjection = TranscriptProjection.Projection.project("child:child:turn:oracle:nested", "", [
  event("shell", 0, "tool.call.requested", {
    data: { tool_call_id: "shell", tool_name: "bash", input: { command: "bun test" } },
  }),
  event("shell-result", 1, "tool.result.received", { data: { tool_call_id: "shell", output: "passed" } }),
])

const entryUnit = (key: string, sequence: number, text: string): TranscriptUnit.Unit => ({
  key,
  turnId: "ordered-turn",
  order: TranscriptOrdering.unitOrder(key, sequence),
  revision: sequence,
  content: { _tag: "Entry", role: "assistant", text },
})

const nestedModel = () => {
  let model = applyTurnUnits(initial("/work"), parentProjection.units)
  model = applyChildUnits(model, "turn:agent", childProjection.units)
  model = applyChildUnits(
    model,
    TranscriptIdentity.scopedIdentity("child:turn:oracle", "nested"),
    grandchildProjection.units,
  )
  return model
}

const childTurnId = (child: number) => `child:turn:agent-${child}`

const childCount = 200
const toolsPerChild = 20
const largeParent = TranscriptProjection.Projection.project("turn", "prompt", [
  event("assistant-0", 0, "model.output.completed", { text: "Fanning out." }),
  ...Array.from({ length: childCount }, (_, child) => [
    event(`agent-${child}`, 1 + child * 2, "tool.call.requested", {
      data: { tool_call_id: `agent-${child}`, tool_name: "task", input: { prompt: `Task ${child}` } },
    }),
    event(`agent-${child}-spawned`, 2 + child * 2, "child_run.spawned", {
      data: { tool_call_id: `agent-${child}`, child_execution_id: childTurnId(child) },
    }),
  ]).flat(),
])
const childProjections = new Map(
  Array.from({ length: childCount }, (_, child) => {
    const events = Array.from({ length: toolsPerChild }, (__, tool) => {
      const requested = event(`tool-${child}-${tool}`, tool * 2, "tool.call.requested", {
        data: {
          tool_call_id: `tool-${child}-${tool}`,
          tool_name: "read",
          input: { path: `src/${child}/${tool}.ts` },
        },
      })
      return tool === toolsPerChild - 1
        ? [requested]
        : [
            requested,
            event(`tool-${child}-${tool}-result`, tool * 2 + 1, "tool.result.received", {
              data: { tool_call_id: `tool-${child}-${tool}`, output: "contents" },
            }),
          ]
    }).flat()
    return [
      childTurnId(child),
      TranscriptProjection.Projection.project(childTurnId(child), "", [
        ...events,
        event(`answer-${child}`, toolsPerChild * 2, "model.output.completed", { text: `Child ${child} finished.` }),
      ]),
    ] as const
  }),
)
const attachedSession = () => {
  const base = applyTurnUnits(initial("/work"), largeParent.units)
  return attachChildProjections(base, new Set<string>(), childProjections)
}

const agentTool = (
  status: "running" | "complete" | "failed" | "cancelled",
  output?: string,
): Extract<TranscriptPresentationModel.Block, { _tag: "ToolCall" }> => ({
  _tag: "ToolCall",
  id: "agent",
  name: "task",
  input: "{}",
  status,
  presentation: {
    family: "agent",
    action: "task",
    activeLabel: "Subagent working",
    completeLabel: "Subagent finished",
  },
  detail: "Do the thing",
  files: [],
  ...(output === undefined ? {} : { output }),
})

const agentScenario = (opts: {
  readonly status: "running" | "complete" | "failed" | "cancelled"
  readonly answer?: string
  readonly errorDetail?: string
  readonly output?: string
  readonly outcomeReason?: string
}) => {
  const tool = agentTool(opts.status, opts.output)
  const entries: Array<Entry> = []
  const blocks: Array<TranscriptPresentationModel.Block> = [tool]
  const items: Array<TranscriptItem> = [{ _tag: "Block", index: 0, id: "tool:agent" }]
  const children: Array<TranscriptItem> = []
  if (opts.answer !== undefined) {
    entries.push({ role: "assistant", text: opts.answer })
    const item: TranscriptItem = {
      _tag: "Entry",
      index: entries.length - 1,
      id: `answer:${entries.length - 1}`,
      parentId: "agent",
    }
    items.push(item)
    children.push(item)
  }
  if (opts.errorDetail !== undefined) {
    blocks.push({ _tag: "Error", title: "Subagent failed", detail: opts.errorDetail })
    const item: TranscriptItem = {
      _tag: "Block",
      index: blocks.length - 1,
      id: `error:${blocks.length - 1}`,
      parentId: "agent",
    }
    items.push(item)
    children.push(item)
  }
  const model: Model = {
    ...initial("/work"),
    entries,
    blocks,
    items,
    ...(opts.outcomeReason === undefined
      ? {}
      : { childExecutionOutcomes: { agent: { status: "failed", reason: opts.outcomeReason } } }),
  }
  return { model, tool, children }
}

const responseStateOf = (opts: Parameters<typeof agentScenario>[0]) => {
  const { model, tool, children } = agentScenario(opts)
  return agentResponseState(model, tool, children)
}

const childContent = ["answer", "error", "both", "neither"] as const

const optsFor = (
  status: "running" | "complete" | "failed" | "cancelled",
  content: (typeof childContent)[number],
): Parameters<typeof agentScenario>[0] => ({
  status,
  ...(content === "answer" || content === "both" ? { answer: "Final answer." } : {}),
  ...(content === "error" || content === "both" ? { errorDetail: "explosion in the reactor" } : {}),
})

const settled = ["complete", "failed", "cancelled"] as const

const limit = 240

const noReport = JSON.stringify({
  _tag: "NoReport",
  childExecutionId: "child:one",
  status: "failed",
  reason: "The subagent finished its run without writing a final report.",
  recovery: "Re-run this delegation once with the same prompt, or do the work yourself.",
})

export const transcriptFixtures = {
  event,
  parentProjection,
  childProjection,
  grandchildProjection,
  entryUnit,
  nestedModel,
  childTurnId,
  childCount,
  toolsPerChild,
  largeParent,
  childProjections,
  attachedSession,
  agentTool,
  agentScenario,
  responseStateOf,
  childContent,
  optsFor,
  settled,
  limit,
  noReport,
}
