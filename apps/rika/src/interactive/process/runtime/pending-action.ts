import * as BunServices from "@effect/platform-bun/BunServices"
import * as PaletteController from "../../controller/palette"
import { execute, type Adapter } from "@rika/terminal/terminal-session"
import { update } from "@rika/terminal/terminal-state-reducer"
import { Effect, Option, Schema } from "effect"
import type { InteractiveLoop } from "./context"

const SetSubagentLimit = Schema.TaggedStruct("SetSubagentLimit", {
  limit: Schema.Literals(["maxDepth", "maxSubagents"]),
  value: Schema.Finite,
})
const PromptPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String, pasted: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("image"), path: Schema.String }),
])
const PendingAction = Schema.Union([
  SetSubagentLimit,
  Schema.TaggedStruct("Submit", {
    prompt: Schema.String,
    parts: Schema.Array(PromptPart),
    mode: Schema.String,
    tuning: Schema.optionalKey(Schema.Struct({ fastMode: Schema.optionalKey(Schema.Boolean) })),
    submissionId: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("EditQueued", { id: Schema.String, prompt: Schema.String }),
  Schema.TaggedStruct("SteerQueued", { id: Schema.String, prompt: Schema.String, requestId: Schema.String }),
  Schema.TaggedStruct("Dequeue", { id: Schema.String }),
  Schema.TaggedStruct("Steer", {
    prompt: Schema.String,
    requestId: Schema.String,
    turnId: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("ApproveAuthorization", { turnId: Schema.String, authorizationId: Schema.String }),
  Schema.TaggedStruct("DenyAuthorization", { turnId: Schema.String, authorizationId: Schema.String }),
  Schema.TaggedStruct("InterruptAndSend", { prompt: Schema.String }),
  Schema.TaggedStruct("Cancel", {
    submissionId: Schema.optionalKey(Schema.String),
    threadId: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("Quit", {}),
  Schema.TaggedStruct("NewThread", {}),
  Schema.TaggedStruct("NewOrbThread", {}),
  Schema.TaggedStruct("SelectThread", { id: Schema.String }),
])

interface PendingActionContext {
  readonly loop: InteractiveLoop
  readonly adapter: Adapter
  readonly run: <E>(effect: Effect.Effect<void, E, BunServices.BunServices>) => void
}

export const pendingActionConsumer =
  ({ loop, adapter, run }: PendingActionContext) =>
  () => {
    const decoded = Schema.decodeUnknownOption(PendingAction)(loop.model.pendingAction)
    if (Option.isNone(decoded)) {
      loop.model = update(loop.model, { _tag: "PaletteActionConsumed" })
      return
    }
    const action = decoded.value
    if (action._tag === "SetSubagentLimit")
      run(
        PaletteController.writeSubagentLimit(loop.model.workspace, action.limit, action.value).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              loop.renderer?.surface.showToast(
                `${action.limit === "maxDepth" ? "Max depth" : "Max subagents"} set to ${action.value}`,
              )
            }),
          ),
          Effect.catch(() =>
            Effect.sync(() => {
              loop.renderer?.surface.showToast("Could not update workspace subagent settings", "#e06c75")
            }),
          ),
        ),
      )
    else execute(adapter, action)
    loop.model = update(loop.model, { _tag: "PaletteActionConsumed" })
  }
