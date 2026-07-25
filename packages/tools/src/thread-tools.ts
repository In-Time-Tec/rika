import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Policy from "./tool-policy"
import { ToolInvocation } from "./tool-invocation"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PublicInputText = NonEmptyString.check(Schema.isMaxLength(200_000))
const BoundedText = Schema.String.check(Schema.isMaxLength(8_000))
const ListText = Schema.String.check(Schema.isMaxLength(128))
const MessageText = Schema.String.check(Schema.isMaxLength(256))
const WaitText = Schema.String.check(Schema.isMaxLength(3_000))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const FindLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(50))
const PreviewLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(20))
const TimeoutSeconds = PositiveInt.check(Schema.isLessThanOrEqualTo(600))
const Mode = Schema.Literals(["low", "medium", "high", "ultra"])
const ResultDelivery = Schema.Literals(["reply", "manual"])
export const ThreadState = Schema.Literals(["idle", "queued", "running", "awaiting-approval", "error"])
export type ThreadState = typeof ThreadState.Type

export const findDefaultLimit = 10
export const findMaximumLimit = 50
export const previewDefaultLimit = 10
export const previewMaximumLimit = 20

export const Result = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })
export type Result = typeof Result.Type

export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ThreadToolError", {
  tool: Schema.String,
  message: Schema.String,
}) {}

export const ToolFailure = Schema.Struct({
  _tag: Schema.tag("ThreadToolError"),
  tool: Schema.String,
  code: Schema.Literals(["not_found", "invalid_state", "unavailable", "timeout", "operation"]),
  message: BoundedText,
  retryable: Schema.Boolean,
})

export const FindThreadInput = Schema.Struct({
  query: NonEmptyString,
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(FindLimit),
})

const TurnCursor = Schema.Struct({ createdAt: Schema.Finite, id: NonEmptyString })
const TranscriptCursor = Schema.Struct({
  createdAt: Schema.Finite,
  turnId: NonEmptyString,
  sequence: Schema.Finite,
  part: Schema.Finite,
  key: Schema.String,
})
const SubtreeCursor = Schema.Union([
  Schema.Struct({
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    before: Schema.optionalKey(TranscriptCursor),
  }),
  Schema.Struct({ before: TranscriptCursor }),
])
const RelationshipCursor = Schema.Struct({ createdAt: Schema.Finite, targetTurnId: NonEmptyString })
const ReadSelection = Schema.Union([
  Schema.Struct({ mode: Schema.tag("overview") }),
  Schema.Struct({
    mode: Schema.tag("recent"),
    limit: Schema.optionalKey(PreviewLimit),
    cursor: Schema.optionalKey(TurnCursor),
  }),
  Schema.Struct({
    mode: Schema.tag("relevant"),
    query: NonEmptyString,
    limit: Schema.optionalKey(PreviewLimit),
    cursor: Schema.optionalKey(TranscriptCursor),
  }),
  Schema.Struct({
    mode: Schema.tag("subtree"),
    childExecutionId: NonEmptyString,
    cursor: Schema.optionalKey(SubtreeCursor),
  }),
  Schema.Struct({ mode: Schema.tag("related"), cursor: Schema.optionalKey(RelationshipCursor) }),
])
export const ReadThreadInput = Schema.Struct({
  threadId: NonEmptyString,
  includeArchived: Schema.optionalKey(Schema.Boolean),
  selection: Schema.optionalKey(ReadSelection),
  maxTurns: Schema.optionalKey(PositiveInt),
  maxChars: Schema.optionalKey(PositiveInt),
})

export const FindThreadSuccess = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  threads: Schema.Array(
    Schema.Struct({
      threadId: NonEmptyString,
      state: ThreadState,
      archived: Schema.Boolean,
      title: ListText,
      updatedAt: NonEmptyString,
      summary: ListText,
      truncated: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(50)),
  truncated: Schema.Boolean,
})

export const CreateThreadInput = Schema.Struct({
  prompt: PublicInputText,
  mode: Schema.optionalKey(Mode),
  resultDelivery: Schema.optionalKey(ResultDelivery),
})

export const AcceptedSuccess = Schema.Struct({
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

const ThreadSelector = Schema.Struct({ threadId: NonEmptyString, turnId: Schema.optionalKey(NonEmptyString) })
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

const make = <Name extends string, Parameters extends Schema.Top, Success extends Schema.Top>(
  name: Name,
  description: string,
  parameters: Parameters,
  success: Success,
) => Tool.make(name, { description, parameters, success, failure: ToolFailure, failureMode: "return" })
const makeCoordination = <Name extends string, Parameters extends Schema.Top, Success extends Schema.Top>(
  name: Name,
  description: string,
  parameters: Parameters,
  success: Success,
) => make(name, description, parameters, success).addDependency(ToolInvocation)

export const searchThreadsTool = Tool.make("search_threads", {
  description: "Internal ReadThread agent tool. Find local Rika threads by bounded plain text and file: query terms.",
  parameters: FindThreadInput,
  success: Result,
  failure: Schema.Struct({ _tag: Schema.tag("ThreadToolError"), tool: Schema.String, message: Schema.String }),
  failureMode: "return",
}).addDependency(ToolInvocation)
export const readThreadTranscriptTool = Tool.make("read_thread_transcript", {
  description:
    "Internal ReadThread agent tool. Read a bounded deterministic transcript for one local Rika thread by id",
  parameters: ReadThreadInput,
  success: Result,
  failure: Schema.Struct({ _tag: Schema.tag("ThreadToolError"), tool: Schema.String, message: Schema.String }),
  failureMode: "return",
}).addDependency(ToolInvocation)
export const findThreadTool = make(
  "find_thread",
  "Find Rika threads by metadata without reading their transcript",
  FindThreadInput,
  FindThreadSuccess,
).addDependency(ToolInvocation)
export const createThreadTool = makeCoordination(
  "create_thread",
  "Create a coordinated Rika thread and accept its first turn",
  CreateThreadInput,
  AcceptedSuccess,
)
export const threadInteractTool = makeCoordination(
  "thread_interact",
  "Inspect, message, or request control of an exact Rika thread",
  ThreadInteractInput,
  ThreadInteractSuccess,
)
export const waitForThreadsTool = makeCoordination(
  "wait_for_threads",
  "Wait for one to ten exact thread turns and return every target status",
  WaitForThreadsInput,
  WaitForThreadsSuccess,
)

export const toolkit = Toolkit.make(searchThreadsTool, readThreadTranscriptTool)
export const findToolkit = Toolkit.make(findThreadTool)
export const coordinationToolkit = Toolkit.make(createThreadTool, threadInteractTool, waitForThreadsTool)
export const publicToolkit = Toolkit.make(findThreadTool, createThreadTool, threadInteractTool, waitForThreadsTool)
export const allToolkit = Toolkit.make(
  searchThreadsTool,
  readThreadTranscriptTool,
  findThreadTool,
  createThreadTool,
  threadInteractTool,
  waitForThreadsTool,
)

const registration = (
  tool: Policy.RegisteredTool,
  idempotency: Policy.Idempotency,
  timeout: number,
  limit: number,
  permission: Policy.ProductPermission,
  action: string,
  activeLabel: string,
  completeLabel: string,
) =>
  Policy.register(
    tool,
    Policy.allow(
      idempotency,
      timeout,
      limit,
      { family: "direct", action, activeLabel, completeLabel, counter: "thread" },
      permission,
    ),
  )

export const registrations: ReadonlyArray<Policy.Registration> = [
  Policy.register(
    searchThreadsTool,
    Policy.allow("safe", 10_000, 20_000, {
      family: "explore",
      action: "find-thread",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "thread",
    }),
  ),
  Policy.register(
    readThreadTranscriptTool,
    Policy.allow("safe", 10_000, 40_000, {
      family: "direct",
      action: "read-thread",
      activeLabel: "Reading Thread",
      completeLabel: "Read Thread",
      counter: "thread",
    }),
  ),
  registration(
    findThreadTool,
    "safe",
    10_000,
    40_000,
    "thread.read",
    "find-thread",
    "Finding threads",
    "Found threads",
  ),
  registration(
    createThreadTool,
    "unsafe",
    30_000,
    40_000,
    "thread.coordinate",
    "create-thread",
    "Creating thread",
    "Created thread",
  ),
  Policy.register(
    threadInteractTool,
    Policy.allow(
      "unsafe",
      30_000,
      40_000,
      {
        family: "direct",
        action: "interact-thread",
        activeLabel: "Coordinating thread",
        completeLabel: "Coordinated thread",
        counter: "thread",
      },
      undefined,
      [
        { actions: ["status", "preview_messages"], productPermission: "thread.read", idempotency: "safe" },
        { actions: ["message"], productPermission: "thread.coordinate", idempotency: "unsafe" },
        { actions: ["steer", "cancel", "stop"], productPermission: "thread.control", idempotency: "unsafe" },
      ],
    ),
  ),
  registration(
    waitForThreadsTool,
    "safe",
    600_000,
    40_000,
    "thread.read",
    "wait-threads",
    "Waiting for threads",
    "Waited for threads",
  ),
]

export const waitHandlerOutputBudget = 36_000
