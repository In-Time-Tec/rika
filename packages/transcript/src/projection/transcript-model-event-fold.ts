import type { Block } from "../schema/transcript-presentation-model"
import type { SourceEvent } from "../schema/transcript-source-event"
import type { MutableMutation, OwnedFold } from "./transcript-fold-state"
import { foldState } from "./transcript-fold-state"
const { makeUnit, setState, sourcePayload, string, upsertUnit } = foldState
import { identityKey } from "../ordering/transcript-unit-identity"

const applyUsage = ({
  value,
  change,
  event,
}: {
  readonly value: OwnedFold
  readonly change: MutableMutation
  readonly event: SourceEvent
}): void => {
  const identity = event.cursor
  if (value.usageCursorSet.has(identity)) return
  value.usageCursorSet.add(identity)
  value.usageCursorList.push(identity)
  change.stateChanged = true
}

const assistantKey = ({ turnId, phase }: { readonly turnId: string; readonly phase: number }): string =>
  identityKey("assistant", turnId, Math.max(0, phase))
const reasoningKey = ({ turnId, phase }: { readonly turnId: string; readonly phase: number }): string =>
  identityKey("reasoning", turnId, Math.max(0, phase))

const assistantText = (event: SourceEvent): string => event.text ?? string(sourcePayload(event).text)

const applyAssistant = ({
  value,
  change,
  turnId,
  event,
  complete,
}: {
  readonly value: OwnedFold
  readonly change: MutableMutation
  readonly turnId: string
  readonly event: SourceEvent
  readonly complete: boolean
}): void => {
  const key = assistantKey({ turnId, phase: value.state.modelPhase })
  const current = value.units.get(key)
  const text = assistantText(event)
  const finish = (): void => {
    if (complete && text.trim().length > 0) setState(value, change, "usableCompletionSequence", event.sequence)
  }
  const aggregateCompletion = complete && typeof sourcePayload(event).model_output === "string"
  if (aggregateCompletion && value.assistantUnits.size > 0) {
    if (current?.content._tag === "Entry" && current.content.role === "assistant")
      upsertUnit(value, change, { ...current, revision: event.sequence })
    finish()
    return
  }
  if (current?.content._tag === "Entry" && current.content.role === "assistant") {
    upsertUnit(value, change, {
      ...current,
      revision: event.sequence,
      content: {
        ...current.content,
        text: complete && text.length > 0 ? text : current.content.text + text,
      },
    })
    finish()
    return
  }
  if (text.length === 0) return
  upsertUnit(
    value,
    change,
    makeUnit(key, turnId, event.sequence, 0, event.sequence, {
      _tag: "Entry",
      role: "assistant",
      text,
    }),
  )
  finish()
}

const applyReasoning = ({
  value,
  change,
  turnId,
  event,
  complete,
}: {
  readonly value: OwnedFold
  readonly change: MutableMutation
  readonly turnId: string
  readonly event: SourceEvent
  readonly complete: boolean
}): void => {
  const key = reasoningKey({ turnId, phase: value.state.modelPhase })
  const current = value.units.get(key)
  const previous =
    current?.content._tag === "Block" && current.content.block._tag === "Reasoning" ? current.content.block.text : ""
  const incoming = event.text ?? string(sourcePayload(event).text)
  const block: Block = {
    _tag: "Reasoning",
    text: complete && incoming.length > 0 ? incoming : previous + incoming,
  }
  upsertUnit(
    value,
    change,
    makeUnit(key, turnId, current?.order.at(-1)?.sequence ?? event.sequence, 0, event.sequence, {
      _tag: "Block",
      block,
    }),
  )
}

export { applyAssistant, applyReasoning, applyUsage, assistantKey, reasoningKey }
