import * as Thread from "@rika/persistence/thread"
import * as ThreadSummary from "@rika/persistence/thread-summary"
import * as TranscriptPage from "@rika/persistence/transcript-page"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Context, Effect, Function, Layer, Runtime, Schema } from "effect"

const Mode = Schema.Literals(["low", "medium", "high", "ultra"])
const ClientWorkspace = { clientWorkspace: Schema.optionalKey(Schema.String) }

const Interactive = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Interactive"),
  prompt: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Mode),
  workspace: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  last: Schema.optionalKey(Schema.Boolean),
  ephemeral: Schema.Boolean,
})

const Run = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Run"),
  prompt: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Mode),
  workspace: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  ephemeral: Schema.Boolean,
  streamJson: Schema.Boolean,
  streamJsonInput: Schema.Boolean,
  streamJsonThinking: Schema.Boolean,
})

const Review = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Review"),
  staged: Schema.Boolean,
  base: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
  ephemeral: Schema.Boolean,
  json: Schema.Boolean,
  paths: Schema.Array(Schema.String),
})

const ThreadNoInput = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.Literals(["new", "last", "top"]),
})
const ThreadContinueLast = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("continue"),
  last: Schema.tag(true),
})
const ThreadContinueIds = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("continue"),
  threadIds: Schema.NonEmptyArray(Schema.String),
})
const ThreadList = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("list"),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int),
})
const ThreadSearch = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("search"),
  query: Schema.NonEmptyArray(Schema.String),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int),
})
const ThreadRename = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("rename"),
  threadId: Schema.String,
  title: Schema.String,
})
const ThreadLabel = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("label"),
  threadId: Schema.String,
  labels: Schema.NonEmptyArray(Schema.String),
})
const ThreadById = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.Literals(["pin", "archive", "unarchive", "delete", "usage"]),
  threadId: Schema.String,
})
const ThreadFork = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("fork"),
  threadId: Schema.String,
  atTurn: Schema.optionalKey(Schema.String),
})
const ThreadExport = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("export"),
  threadId: Schema.String,
  format: Schema.Literals(["json", "markdown"]),
})

const ConfigNoInput = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Config"),
  action: Schema.Literals(["list", "keymap"]),
})
const ConfigEdit = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Config"),
  action: Schema.tag("edit"),
  workspace: Schema.Boolean,
})

const Auth = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Auth"),
  action: Schema.Literals(["login", "status", "logout"]),
  provider: Schema.tag("openai"),
  deviceCode: Schema.optionalKey(Schema.Boolean),
})

const McpNoInput = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.Literals(["list", "doctor"]),
})
const McpAddCommand = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("add"),
  name: Schema.String,
  command: Schema.NonEmptyArray(Schema.String),
})
const McpAddUrl = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("add"),
  name: Schema.String,
  url: Schema.String,
})
const McpNamed = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.Literals(["remove", "enable", "disable", "oauth-login", "oauth-logout"]),
  name: Schema.String,
})
const McpApprove = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("approve"),
  name: Schema.String,
  workspace: Schema.optionalKey(Schema.String),
})
const McpOauthStatus = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("oauth-status"),
  name: Schema.optionalKey(Schema.String),
})

const SkillList = Schema.Struct({ ...ClientWorkspace, _tag: Schema.tag("Skill"), action: Schema.tag("list") })
const SkillNamed = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Skill"),
  action: Schema.Literals(["inspect", "remove"]),
  name: Schema.String,
})
const SkillAdd = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Skill"),
  action: Schema.tag("add"),
  source: Schema.String,
})

const ToolList = Schema.Struct({
  _tag: Schema.tag("ToolCatalog"),
  action: Schema.tag("list"),
  mode: Schema.optionalKey(Mode),
})
const ToolShow = Schema.Struct({ _tag: Schema.tag("ToolCatalog"), action: Schema.tag("show"), name: Schema.String })

const Extension = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Extension"),
  action: Schema.Literals(["create-skill", "create-plugin", "enable", "disable", "rollback"]),
  name: Schema.String,
})
const ExtensionList = Schema.Struct({ ...ClientWorkspace, _tag: Schema.tag("Extension"), action: Schema.tag("list") })
const Doctor = Schema.Struct({ ...ClientWorkspace, _tag: Schema.tag("Doctor") })
const Update = Schema.Struct({ _tag: Schema.tag("Update") })
const WorkflowStart = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Workflow"),
  action: Schema.tag("start"),
  name: Schema.Literals(["delivery", "research-synthesis"]),
  runId: Schema.String,
  revision: Schema.optionalKey(Schema.Int),
})
const WorkflowInspect = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Workflow"),
  action: Schema.Literals(["inspect", "cancel"]),
  runId: Schema.String,
})

export const Input = Schema.Union([
  Interactive,
  Run,
  Review,
  ThreadNoInput,
  ThreadContinueLast,
  ThreadContinueIds,
  ThreadList,
  ThreadSearch,
  ThreadRename,
  ThreadLabel,
  ThreadById,
  ThreadFork,
  ThreadExport,
  ConfigNoInput,
  ConfigEdit,
  Auth,
  McpNoInput,
  McpAddCommand,
  McpAddUrl,
  McpNamed,
  McpApprove,
  McpOauthStatus,
  SkillList,
  SkillNamed,
  SkillAdd,
  ToolList,
  ToolShow,
  Extension,
  ExtensionList,
  Doctor,
  Update,
  WorkflowStart,
  WorkflowInspect,
])
export type Input = typeof Input.Type

export class OperationUnavailable extends Schema.TaggedErrorClass<OperationUnavailable>()("OperationUnavailable", {
  operation: Schema.String,
  message: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2
  override readonly [Runtime.errorReported] = false
}

export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()("InvalidInput", {
  message: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2
  override readonly [Runtime.errorReported] = false
}

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<void, OperationUnavailable>
}

export class Service extends Context.Service<Service, Interface>()("@rika/app/operation-contract/Service") {}

export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    run: Effect.fn("Operation.run")(function* (input) {
      return yield* OperationUnavailable.make({
        operation: input._tag,
        message: `${input._tag} is specified but not implemented yet`,
      })
    }),
  }),
)

export interface QueueItem {
  readonly id: Turn.TurnId
  readonly prompt: string
  readonly attachments?: ReadonlyArray<string>
}

export type QueueChange =
  | { readonly _tag: "Reset"; readonly items: ReadonlyArray<QueueItem> }
  | { readonly _tag: "Added"; readonly item: QueueItem }
  | { readonly _tag: "Updated"; readonly item: QueueItem }
  | { readonly _tag: "Removed"; readonly turnId: Turn.TurnId }

export type InteractiveEvent =
  | { readonly _tag: "ThreadsListed"; readonly threads: ReadonlyArray<ThreadSummary.ThreadSummary> }
  | {
      readonly _tag: "ThreadUsageUpdated"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly cost: { readonly _tag: "Available"; readonly usd: number } | { readonly _tag: "Unavailable" }
      readonly tokens: { readonly _tag: "Available"; readonly total: number } | { readonly _tag: "Unavailable" }
    }
  | {
      readonly _tag: "ContextDiagnostics"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly messages: ReadonlyArray<string>
    }
  | {
      readonly _tag: "TitleCostUpdated"
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly turnCostUsd: number
      readonly threadCostUsd: number
      readonly globalCostUsd: number
    }
  | {
      readonly _tag: "TranscriptPatched"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly rootTurnId?: Turn.TurnId
      readonly rootTurnCostUsd?: number
      readonly threadCostUsd?: number
      readonly globalCostUsd?: number
      readonly event: ExecutionBackend.Event
      readonly revision: number
    }
  | {
      readonly _tag: "TranscriptResyncRequired"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly reason: string
    }
  | { readonly _tag: "AssistantCompleted"; readonly text: string }
  | {
      readonly _tag: "ExecutionFailed"
      readonly selectionEpoch: number
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly message: string
    }
  | {
      readonly _tag: "QueueUpdated"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly revision: number
      readonly queuedCount: number
      readonly change: QueueChange
    }
  | {
      readonly _tag: "QueueFull"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly capacity: number
      readonly count: number
    }
  | {
      readonly _tag: "QueueResyncRequired"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly reason: string
    }
  | {
      readonly _tag: "TurnStarted"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turn: Turn.Turn
      readonly submissionId?: string
    }
  | {
      readonly _tag: "SubmissionAdmitted"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly status: "active" | "queued"
      readonly submissionId?: string
    }
  | {
      readonly _tag: "SelectionLoaded"
      readonly selectionEpoch: number
      readonly activitySequence: number
      readonly thread: Thread.Thread
      readonly entries: ReadonlyArray<TranscriptPage.Entry>
      readonly hasOlder: boolean
      readonly threadCostUsd?: number
      readonly globalCostUsd?: number
      readonly oldestCursor?: TranscriptPage.PageCursor
      readonly queueRevision: number
      readonly queuedCount?: number
      readonly queue: ReadonlyArray<QueueItem>
      readonly activeTurn?: Turn.Turn
    }
  | {
      readonly _tag: "TranscriptReplaced"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly entries: ReadonlyArray<TranscriptPage.Entry>
      readonly hasOlder: boolean
      readonly threadCostUsd?: number
      readonly globalCostUsd?: number
      readonly oldestCursor?: TranscriptPage.PageCursor
    }
  | {
      readonly _tag: "TranscriptPagePrepended"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly entries: ReadonlyArray<TranscriptPage.Entry>
      readonly hasOlder: boolean
      readonly threadCostUsd?: number
      readonly globalCostUsd?: number
      readonly oldestCursor?: TranscriptPage.PageCursor
    }
  | { readonly _tag: "ShellPermissionRequested"; readonly id: string; readonly command: string }
  | { readonly _tag: "ShellPermissionCancelled"; readonly id: string }
  | { readonly _tag: "ShellCompleted"; readonly command: string; readonly text: string; readonly incognito: boolean }
  | {
      readonly _tag: "ExecutionControlled"
      readonly selectionEpoch: number
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly action: "steered" | "cancelled" | "permission-resolved"
      readonly agentResponseArrived?: boolean
      readonly steeringSequence?: number
      readonly steeringText?: string
    }
  | { readonly _tag: "ThreadTitled"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "ThreadActivated"; readonly threadId: string; readonly title: string }
  | {
      readonly _tag: "ThreadPreviewLoaded"
      readonly threadId: string
      readonly turns: ReadonlyArray<{ readonly prompt: string; readonly events: ReadonlyArray<ExecutionBackend.Event> }>
    }

export const InteractiveEventSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("ThreadUsageUpdated"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    cost: Schema.Union([
      Schema.Struct({ _tag: Schema.tag("Available"), usd: Schema.Finite }),
      Schema.Struct({ _tag: Schema.tag("Unavailable") }),
    ]),
    tokens: Schema.Union([
      Schema.Struct({ _tag: Schema.tag("Available"), total: Schema.Finite }),
      Schema.Struct({ _tag: Schema.tag("Unavailable") }),
    ]),
  }),
  Schema.Struct({
    _tag: Schema.tag("ContextDiagnostics"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    messages: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("TitleCostUpdated"),
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    turnCostUsd: Schema.Finite,
    threadCostUsd: Schema.Finite,
    globalCostUsd: Schema.Finite,
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptPatched"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    rootTurnId: Schema.optionalKey(Turn.TurnId),
    rootTurnCostUsd: Schema.optionalKey(Schema.Finite),
    threadCostUsd: Schema.optionalKey(Schema.Finite),
    globalCostUsd: Schema.optionalKey(Schema.Finite),
    event: ExecutionBackend.Event,
    revision: Schema.Finite,
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptResyncRequired"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    reason: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadsListed"), threads: Schema.Array(ThreadSummary.ThreadSummary) }),
  Schema.Struct({ _tag: Schema.tag("AssistantCompleted"), text: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionFailed"),
    selectionEpoch: Schema.Int,
    threadId: Schema.optionalKey(Thread.ThreadId),
    turnId: Schema.optionalKey(Turn.TurnId),
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("QueueUpdated"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    revision: Schema.Int,
    queuedCount: Schema.Int,
    change: Schema.Union([
      Schema.Struct({
        _tag: Schema.tag("Reset"),
        items: Schema.Array(
          Schema.Struct({
            id: Turn.TurnId,
            prompt: Schema.String,
            attachments: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      }),
      Schema.Struct({
        _tag: Schema.tag("Added"),
        item: Schema.Struct({
          id: Turn.TurnId,
          prompt: Schema.String,
          attachments: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      }),
      Schema.Struct({
        _tag: Schema.tag("Updated"),
        item: Schema.Struct({
          id: Turn.TurnId,
          prompt: Schema.String,
          attachments: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      }),
      Schema.Struct({ _tag: Schema.tag("Removed"), turnId: Turn.TurnId }),
    ]),
  }),
  Schema.Struct({
    _tag: Schema.tag("QueueFull"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    capacity: Schema.Int,
    count: Schema.Int,
  }),
  Schema.Struct({
    _tag: Schema.tag("QueueResyncRequired"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    reason: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("TurnStarted"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    turn: Turn.Turn,
    submissionId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("SubmissionAdmitted"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    status: Schema.Literals(["active", "queued"]),
    submissionId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("SelectionLoaded"),
    selectionEpoch: Schema.Int,
    activitySequence: Schema.Int,
    thread: Thread.Thread,
    entries: Schema.Array(TranscriptPage.EntrySchema),
    hasOlder: Schema.Boolean,
    threadCostUsd: Schema.optionalKey(Schema.Finite),
    globalCostUsd: Schema.optionalKey(Schema.Finite),
    oldestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
    queueRevision: Schema.Int,
    queuedCount: Schema.optionalKey(Schema.Int),
    queue: Schema.Array(
      Schema.Struct({
        id: Turn.TurnId,
        prompt: Schema.String,
        attachments: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
    activeTurn: Schema.optionalKey(Turn.Turn),
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptReplaced"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    entries: Schema.Array(TranscriptPage.EntrySchema),
    hasOlder: Schema.Boolean,
    threadCostUsd: Schema.optionalKey(Schema.Finite),
    globalCostUsd: Schema.optionalKey(Schema.Finite),
    oldestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptPagePrepended"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    entries: Schema.Array(TranscriptPage.EntrySchema),
    hasOlder: Schema.Boolean,
    threadCostUsd: Schema.optionalKey(Schema.Finite),
    globalCostUsd: Schema.optionalKey(Schema.Finite),
    oldestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
  }),
  Schema.Struct({ _tag: Schema.tag("ShellPermissionRequested"), id: Schema.String, command: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("ShellPermissionCancelled"), id: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ShellCompleted"),
    command: Schema.String,
    text: Schema.String,
    incognito: Schema.Boolean,
  }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionControlled"),
    selectionEpoch: Schema.Int,
    threadId: Schema.optionalKey(Thread.ThreadId),
    turnId: Schema.optionalKey(Turn.TurnId),
    action: Schema.Literals(["steered", "cancelled", "permission-resolved"]),
    agentResponseArrived: Schema.optionalKey(Schema.Boolean),
    steeringSequence: Schema.optionalKey(Schema.Int),
    steeringText: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadTitled"), threadId: Schema.String, title: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("ThreadActivated"), threadId: Schema.String, title: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ThreadPreviewLoaded"),
    threadId: Schema.String,
    turns: Schema.Array(Schema.Struct({ prompt: Schema.String, events: Schema.Array(ExecutionBackend.Event) })),
  }),
])

export const InteractiveCommand = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Submit"),
    prompt: Schema.String,
    submissionId: Schema.optionalKey(Schema.String),
    mode: Schema.optionalKey(Mode),
    promptParts: Schema.optionalKey(Schema.Array(Turn.PromptPart)),
    modelTuning: Schema.optionalKey(
      Schema.Struct({
        fastMode: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
  Schema.Struct({ _tag: Schema.tag("Shell"), command: Schema.String, incognito: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.tag("EditQueued"), turnId: Schema.String, prompt: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Dequeue"), turnId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("SteerQueued"), turnId: Schema.String, text: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Steer"), text: Schema.String, turnId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ _tag: Schema.tag("InterruptAndSend"), prompt: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Cancel") }),
  Schema.Struct({ _tag: Schema.tag("NewThread") }),
  Schema.Struct({
    _tag: Schema.tag("ResolvePermission"),
    waitId: Schema.String,
    kind: Schema.Literals(["permission", "tool-approval"]),
    decision: Schema.Literals(["allow", "deny", "always"]),
  }),
  Schema.Struct({
    _tag: Schema.tag("SelectThread"),
    threadId: Schema.String,
    selectionEpoch: Schema.Int,
  }),
  Schema.Struct({ _tag: Schema.tag("ReadQueue"), threadId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("LoadOlder") }),
  Schema.Struct({ _tag: Schema.tag("PreviewThread"), threadId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("ReopenThread"), selectionEpoch: Schema.Int }),
  Schema.Struct({
    _tag: Schema.tag("Replay"),
    turnId: Schema.String,
    afterCursor: Schema.optionalKey(Schema.String),
  }),
])
export type InteractiveCommand = typeof InteractiveCommand.Type

export interface InteractiveSession {
  readonly events: (dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, OperationUnavailable>
  readonly submit: (
    prompt: string,
    mode?: "low" | "medium" | "high" | "ultra",
    promptParts?: ReadonlyArray<Turn.PromptPart>,
    modelTuning?: { readonly fastMode?: boolean },
    submissionId?: string,
  ) => Effect.Effect<void, OperationUnavailable>
  readonly shell: (command: string, incognito: boolean) => Effect.Effect<void, OperationUnavailable>
  readonly editQueued: (turnId: string, prompt: string) => Effect.Effect<void, OperationUnavailable>
  readonly dequeue: (turnId: string) => Effect.Effect<void, OperationUnavailable>
  readonly steerQueued: (turnId: string, text: string) => Effect.Effect<void, OperationUnavailable>
  readonly steer: (text: string, targetTurnId?: string) => Effect.Effect<void, OperationUnavailable>
  readonly interruptAndSend: (prompt: string) => Effect.Effect<void, OperationUnavailable>
  readonly cancel: Effect.Effect<void, OperationUnavailable>
  readonly newThread: Effect.Effect<void, OperationUnavailable>
  readonly resolvePermission: (
    waitId: string,
    kind: "permission" | "tool-approval",
    decision: "allow" | "deny" | "always",
  ) => Effect.Effect<void, OperationUnavailable>
  readonly selectThread: (threadId: string, selectionEpoch: number) => Effect.Effect<void, OperationUnavailable>
  readonly readQueue: (threadId: string) => Effect.Effect<void, OperationUnavailable>
  readonly loadOlder: Effect.Effect<void, OperationUnavailable>
  readonly previewThread: (threadId: string) => Effect.Effect<void, OperationUnavailable>
  readonly reopenThread: (selectionEpoch: number) => Effect.Effect<void, OperationUnavailable>
  readonly replay: (turnId: string, afterCursor: string | undefined) => Effect.Effect<void, OperationUnavailable>
}

const executeInteractiveCommandImpl = (session: InteractiveSession, command: InteractiveCommand) => {
  switch (command._tag) {
    case "Submit":
      return session.submit(
        command.prompt,
        command.mode,
        command.promptParts,
        command.modelTuning,
        command.submissionId,
      )
    case "Shell":
      return session.shell(command.command, command.incognito)
    case "EditQueued":
      return session.editQueued(command.turnId, command.prompt)
    case "Dequeue":
      return session.dequeue(command.turnId)
    case "SteerQueued":
      return session.steerQueued(command.turnId, command.text)
    case "Steer":
      return session.steer(command.text, command.turnId)
    case "InterruptAndSend":
      return session.interruptAndSend(command.prompt)
    case "Cancel":
      return session.cancel
    case "NewThread":
      return session.newThread
    case "ResolvePermission":
      return session.resolvePermission(command.waitId, command.kind, command.decision)
    case "SelectThread":
      return session.selectThread(command.threadId, command.selectionEpoch)
    case "ReadQueue":
      return session.readQueue(command.threadId)
    case "LoadOlder":
      return session.loadOlder
    case "PreviewThread":
      return session.previewThread(command.threadId)
    case "ReopenThread":
      return session.reopenThread(command.selectionEpoch)
    case "Replay":
      return session.replay(command.turnId, command.afterCursor)
  }
}

export const executeInteractiveCommand: {
  (command: InteractiveCommand): (session: InteractiveSession) => Effect.Effect<void, OperationUnavailable>
  (session: InteractiveSession, command: InteractiveCommand): Effect.Effect<void, OperationUnavailable>
} = Function.dual(2, executeInteractiveCommandImpl)
