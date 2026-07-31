import { Schema } from "effect"
import { ModeId } from "@rika/configuration/behavior-mode"
import { ThreadState } from "./thread-tool-find-contract"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PublicInputText = NonEmptyString.check(Schema.isMaxLength(200_000))
const BoundedText = Schema.String.check(Schema.isMaxLength(8_000))
const MessageText = Schema.String.check(Schema.isMaxLength(256))
const WaitText = Schema.String.check(Schema.isMaxLength(3_000))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const PreviewLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(20))
const TimeoutSeconds = PositiveInt.check(Schema.isLessThanOrEqualTo(600))
const Mode = ModeId
const ResultDelivery = Schema.Literals(["reply", "manual"])
const ThreadSelector = Schema.Struct({ threadId: NonEmptyString, turnId: Schema.optionalKey(NonEmptyString) })
const AcceptedSuccess = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  threadId: NonEmptyString,
  turnId: NonEmptyString,
  resultDelivery: ResultDelivery,
  state: ThreadState,
})
const StatusAction = Schema.Struct({ action: Schema.tag("status"), threadId: NonEmptyString })
const PreviewMessagesAction = Schema.Struct({
  action: Schema.tag("preview_messages"),
  threadId: NonEmptyString,
  cursor: Schema.optionalKey(NonEmptyString),
  limit: Schema.optionalKey(PreviewLimit),
})
const MessageAction = Schema.Struct({
  action: Schema.tag("message"),
  threadId: NonEmptyString,
  message: PublicInputText,
  mode: Schema.optionalKey(Mode),
  resultDelivery: Schema.optionalKey(ResultDelivery),
})
const SteerAction = Schema.Struct({ action: Schema.tag("steer"), threadId: NonEmptyString, message: PublicInputText })
const CancelAction = Schema.Struct({ action: Schema.tag("cancel"), threadId: NonEmptyString })
const StopAction = Schema.Struct({ action: Schema.tag("stop"), threadId: NonEmptyString })
export const CreateThreadInput = Schema.Struct({
  prompt: PublicInputText,
  mode: Schema.optionalKey(Mode),
  resultDelivery: Schema.optionalKey(ResultDelivery),
})
export const ThreadInteractAction = Schema.Union([
  StatusAction,
  PreviewMessagesAction,
  MessageAction,
  SteerAction,
  CancelAction,
  StopAction,
])
export const ThreadInteractInput = Schema.Struct({
  action: Schema.Literals(["status", "preview_messages", "message", "steer", "cancel", "stop"]),
  threadId: NonEmptyString,
  cursor: Schema.optionalKey(NonEmptyString),
  limit: Schema.optionalKey(PreviewLimit),
  message: Schema.optionalKey(PublicInputText),
  mode: Schema.optionalKey(Mode),
  resultDelivery: Schema.optionalKey(ResultDelivery),
}).check(
  Schema.makeFilter(
    (input) => (input.action === "message" || input.action === "steer" ? input.message !== undefined : true),
    { expected: "message to be present when action is message or steer" },
  ),
)
const StatusSuccess = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  action: Schema.tag("status"),
  selector: ThreadSelector,
  state: ThreadState,
  resultDelivery: Schema.optionalKey(ResultDelivery),
  detail: BoundedText,
  truncated: Schema.Boolean,
})
const PreviewSuccess = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  action: Schema.tag("preview_messages"),
  selector: ThreadSelector,
  state: ThreadState,
  messages: Schema.Array(
    Schema.Struct({ messageId: NonEmptyString, role: NonEmptyString, text: MessageText, truncated: Schema.Boolean }),
  ).check(Schema.isMaxLength(20)),
  nextCursor: Schema.optionalKey(NonEmptyString),
  truncated: Schema.Boolean,
})
const ControlSuccess = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  action: Schema.Literals(["steer", "cancel", "stop"]),
  selector: ThreadSelector,
  state: ThreadState,
  detail: BoundedText,
  truncated: Schema.Boolean,
})
export { AcceptedSuccess }
export const ThreadInteractSuccess = Schema.Union([AcceptedSuccess, StatusSuccess, PreviewSuccess, ControlSuccess])
export const WaitForThreadsInput = Schema.Struct({
  targets: Schema.Array(Schema.Struct({ threadId: NonEmptyString, turnId: NonEmptyString })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(10),
  ),
  timeoutSeconds: Schema.optionalKey(TimeoutSeconds),
})
export const WaitForThreadsSuccess = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  targets: Schema.Array(
    Schema.Struct({
      threadId: NonEmptyString,
      turnId: NonEmptyString,
      state: ThreadState,
      resultDelivery: ResultDelivery,
      text: WaitText,
      truncated: Schema.Boolean,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  timedOut: Schema.Boolean,
  truncated: Schema.Boolean,
})
