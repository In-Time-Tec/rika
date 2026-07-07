import { Config } from "@rika/core"
import { ModelInfo } from "@rika/llm"
import { Common, Event, Ids, Message, Orb, Remote } from "@rika/schema"
import { isAbsolute, relative } from "node:path"

export type Activity = "idle" | "thinking" | "streaming" | "running-tools" | "failed"
export type CardKind = "context" | "tool" | "diff" | "error" | "skill" | "subagent" | "system"
export type CardStatus = "info" | "running" | "success" | "error"
export type CardContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "pierre-diff"; readonly file_diff: Common.JsonValue }

export interface ThreadMessage {
  readonly id: string
  readonly role: Message.Role
  readonly text: string
  readonly user_id?: Ids.UserId
}

export interface PresenceUser {
  readonly user_id: Ids.UserId
  readonly state: Remote.PresenceState
}

export interface Card {
  readonly id: string
  readonly kind: CardKind
  readonly title: string
  readonly subtitle: string
  readonly status: CardStatus
  readonly collapsed: boolean
  readonly content?: CardContent
  readonly tool_name?: string
  readonly expandable?: boolean
  readonly path?: string
  readonly range?: Common.LineRange
}

export type TranscriptEntry =
  | { readonly kind: "message"; readonly message: ThreadMessage }
  | { readonly kind: "card"; readonly card: Card }

export interface Input {
  readonly thread_id: Ids.ThreadId
  readonly workspace_path: string
  readonly mode: Config.Mode
  readonly user_id?: Ids.UserId
  readonly events?: ReadonlyArray<Event.Event>
  readonly active_orb?: ActiveOrb
  readonly context_tokens?: number
  readonly context_window?: number
}

export interface ActiveOrb {
  readonly orb_id: Ids.OrbId
  readonly status: Orb.OrbStatus
}

export interface InputBuffer {
  readonly text: string
  readonly cursor: number
  readonly attachments: ReadonlyArray<InputAttachment>
}

export type InputAttachment =
  | { readonly kind: "image"; readonly token: string; readonly text: string; readonly path: string }
  | { readonly kind: "paste"; readonly token: string; readonly text: string; readonly value: string }

export type SubmittedInputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly path: string; readonly text: string }

export interface ThinkingState {
  readonly text: string
  readonly visible: boolean
}

export interface PaletteState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
}

export const modePickerFamilies = ["deep", "rush", "smart"] as const
export type ModePickerFamily = (typeof modePickerFamilies)[number]

export interface ModePickerState {
  readonly open: boolean
  readonly selected: number
}

export interface PickerItem {
  readonly label: string
  readonly insert: string
}

export interface FilePickerState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
  readonly kind: "file" | "thread"
  readonly items: ReadonlyArray<PickerItem>
}

export interface ThreadDiffStats {
  readonly additions: number
  readonly modifications: number
  readonly deletions: number
}

export type ThreadSwitcherPreview =
  | { readonly status: "unloaded" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly state: ViewState }
  | { readonly status: "failed"; readonly message: string }

export interface ThreadSwitcherItem {
  readonly thread_id: Ids.ThreadId
  readonly title: string
  readonly preview: string
  readonly updated_label: string
  readonly archived: boolean
  readonly orb_status?: Orb.OrbStatus
  readonly diff?: ThreadDiffStats
  readonly preview_state: ThreadSwitcherPreview
}

export interface ThreadSwitcherState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
  readonly items: ReadonlyArray<ThreadSwitcherItem>
}

export interface RemoteArmState {
  readonly enabled: boolean
  readonly project_name?: string
}

export type ContextUsageTone = "normal" | "warning" | "danger"

export interface ContextUsage {
  readonly tokens: number
  readonly window: number
  readonly percent: number
  readonly tone: ContextUsageTone
}

export interface ViewState {
  readonly thread_id: Ids.ThreadId
  readonly active_orb?: ActiveOrb
  readonly workspace_path: string
  readonly git_branch?: string
  readonly mode: Config.Mode
  readonly user_id?: Ids.UserId
  readonly cost_usd: number
  readonly reasoning_effort: number
  readonly fast_mode: boolean
  readonly activity: Activity
  readonly active: boolean
  readonly spinner_index: number
  readonly connecting_ticks: number
  readonly mode_switch_ticks: number
  readonly mode_switch_kind: "mode" | "tier"
  readonly deep_tier: number
  readonly messages: ReadonlyArray<ThreadMessage>
  readonly cards: ReadonlyArray<Card>
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly streaming_text: string
  readonly generated_text_chars: number
  readonly notice?: string
  readonly palette_open: boolean
  readonly input: InputBuffer
  readonly focus_index?: number
  readonly expanded_ids: ReadonlySet<string>
  readonly details_expanded: boolean
  readonly tool_group_expanded: boolean
  readonly queued: ReadonlyArray<string>
  readonly queue_selected: number
  readonly history: ReadonlyArray<string>
  readonly history_index: number
  readonly nav_index: number
  readonly thinking: ThinkingState
  readonly palette: PaletteState
  readonly modepicker: ModePickerState
  readonly filepicker: FilePickerState
  readonly threadswitcher: ThreadSwitcherState
  readonly remoteArm: RemoteArmState
  readonly shortcuts_open: boolean
  readonly presence: ReadonlyArray<PresenceUser>
  readonly context_usage?: ContextUsage
}

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
export const connectingTicks = 12
export const modeSwitchTicks = 8
export const maxStreamingTextChars = 12000
export const isDeepMode = (mode: Config.Mode): boolean => mode === "deep1" || mode === "deep2" || mode === "deep3"
export const deepModeTier = (mode: Config.Mode): number =>
  mode === "deep1" ? 1 : mode === "deep2" ? 2 : mode === "deep3" ? 3 : 0
export const isFastEligible = (mode: Config.Mode): boolean => mode === "rush" || isDeepMode(mode)

const emptyInput: InputBuffer = { text: "", cursor: 0, attachments: [] }
const closedPalette: PaletteState = { open: false, query: "", selected: 0 }
const closedModePicker: ModePickerState = { open: false, selected: 0 }
const closedFilePicker: FilePickerState = { open: false, query: "", selected: 0, kind: "file", items: [] }
const closedThreadSwitcher: ThreadSwitcherState = { open: false, query: "", selected: 0, items: [] }
const remoteArmDefault: RemoteArmState = { enabled: false }
const hiddenThinking: ThinkingState = { text: "", visible: false }

const interactionDefaults = {
  input: emptyInput,
  expanded_ids: new Set<string>() as ReadonlySet<string>,
  details_expanded: false,
  tool_group_expanded: false,
  queued: [] as ReadonlyArray<string>,
  queue_selected: -1,
  history: [] as ReadonlyArray<string>,
  history_index: -1,
  nav_index: -1,
  thinking: hiddenThinking,
  palette: closedPalette,
  modepicker: closedModePicker,
  filepicker: closedFilePicker,
  threadswitcher: closedThreadSwitcher,
  remoteArm: remoteArmDefault,
  palette_open: false,
  shortcuts_open: false,
  presence: [] as ReadonlyArray<PresenceUser>,
}

export const initial = (input: Input): ViewState =>
  fromEvents({ ...input, events: input.events ?? [] }, initialSeed(input))

export const fromEvents = (input: Input, seed = initialSeed(input)): ViewState =>
  (input.events ?? []).reduce((state, event) => applyEvent(state, event), seed)

const modeDefaultEffort = deepModeTier

const initialSeed = (input: Input): ViewState => ({
  thread_id: input.thread_id,
  ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
  ...(input.active_orb === undefined ? {} : { active_orb: input.active_orb }),
  workspace_path: input.workspace_path,
  mode: input.mode,
  cost_usd: 0,
  reasoning_effort: modeDefaultEffort(input.mode),
  fast_mode: false,
  activity: "idle",
  active: false,
  spinner_index: 0,
  connecting_ticks: 0,
  mode_switch_ticks: 0,
  mode_switch_kind: "mode",
  deep_tier: isDeepMode(input.mode) ? deepModeTier(input.mode) : 3,
  messages: [],
  cards: [],
  entries: [],
  streaming_text: "",
  generated_text_chars: 0,
  ...initialContextUsage(input),
  ...interactionDefaults,
})

export const applyEvent = (state: ViewState, event: Event.Event): ViewState => {
  switch (event.type) {
    case "thread.created":
      return withoutNotice({ ...state, thread_id: event.thread_id })
    case "turn.started":
      return tick(
        withoutNotice({ ...state, activity: "thinking", active: true, streaming_text: "", generated_text_chars: 0 }),
      )
    case "message.added":
      return applyMessage(state, event)
    case "context.resolved":
      return tick({ ...state, activity: "thinking", active: true })
    case "context.compacted":
      return pushCard(state, systemCard("Context compacted", event.data.trigger, event.id))
    case "context.pruned":
      return pushCard(state, systemCard("Context pruned", contextPrunedSubtitle(event), event.id))
    case "skill.loaded":
      return tick(pushCard({ ...state, activity: "thinking", active: true }, skillCard(event)))
    case "subagent.completed":
      return tick(pushCard({ ...state, activity: "streaming", active: true }, subagentCard(event)))
    case "model.stream.chunk":
      return tick({
        ...state,
        activity: "streaming",
        active: true,
        streaming_text: appendStreamingText(state.streaming_text, event.data.text),
        generated_text_chars: state.generated_text_chars + event.data.text.length,
      })
    case "model.reasoning.delta":
      return tick(withReasoningDelta(state, event.data.text))
    case "tool.call.input.started":
      return tick(
        updateCard({ ...state, activity: "streaming", active: true, streaming_text: "" }, toolInputCard(event)),
      )
    case "tool.call.input.delta":
      return tick({
        ...state,
        activity: "streaming",
        active: true,
        streaming_text: "",
        generated_text_chars: state.generated_text_chars + event.data.text.length,
      })
    case "tool.call.input.ended":
      return tick({ ...state, activity: "streaming", active: true, streaming_text: "" })
    case "tool.call.requested":
      return tick(
        updateCard({ ...state, activity: "running-tools", active: true, streaming_text: "" }, toolCard(state, event)),
      )
    case "tool.call.completed":
      return tick(applyToolResult({ ...state, activity: "streaming", active: true }, event))
    case "artifact.created":
      return pushCard(state, systemCard("Artifact created", event.data.artifact.kind, event.id))
    case "turn.completed":
      return finishTurn(withContextUsageFromTurn(state, event))
    case "turn.failed":
      return pushCard(finishTurn(state, "failed"), errorCard(event))
    case "thread.archived":
      return pushCard({ ...state, active: false, activity: "idle" }, systemCard("Thread archived", "", event.id))
  }
  return state
}

export const finishTurn = (state: ViewState, activity: "idle" | "failed" = "idle"): ViewState => ({
  ...state,
  activity,
  active: false,
  streaming_text: "",
  generated_text_chars: 0,
})

export const deepModeForTier = (tier: number): Config.Mode => (tier === 2 ? "deep2" : tier === 3 ? "deep3" : "deep1")

export const withMode = (state: ViewState, mode: Config.Mode): ViewState => {
  if (modeLocked(state)) return state
  return {
    ...state,
    mode,
    reasoning_effort: modeDefaultEffort(mode),
    fast_mode: isFastEligible(mode) ? state.fast_mode : false,
    mode_switch_ticks: mode === state.mode ? state.mode_switch_ticks : modeSwitchTicks,
    mode_switch_kind: "mode",
    deep_tier: isDeepMode(mode) ? deepModeTier(mode) : state.deep_tier,
  }
}

export const cycleReasoning = (state: ViewState): ViewState => {
  if (modeLocked(state)) return state
  const next = nextReasoningMode(state.mode)
  return {
    ...state,
    mode: next,
    reasoning_effort: modeDefaultEffort(next),
    mode_switch_ticks: next === state.mode ? state.mode_switch_ticks : modeSwitchTicks,
    mode_switch_kind: "tier",
    deep_tier: isDeepMode(next) ? deepModeTier(next) : state.deep_tier,
  }
}

export const toggleFastMode = (state: ViewState): ViewState => ({ ...state, fast_mode: !state.fast_mode })

export const withGitBranch = (state: ViewState, branch: string | undefined): ViewState => ({
  ...state,
  ...(branch === undefined ? {} : { git_branch: branch }),
})

export const hasActivity = (state: ViewState): boolean => state.entries.length > 0

export const modeLocked = (state: ViewState): boolean => state.active || hasActivity(state)

export const hasActiveOrb = (state: ViewState): boolean => state.active_orb !== undefined

export const withActiveOrb = (state: ViewState, activeOrb: ActiveOrb): ViewState => ({
  ...state,
  active_orb: activeOrb,
})

export const contextUsageLabel = (usage: ContextUsage): string => `ctx ${usage.percent}%`

export const withThread = (
  state: ViewState,
  input: {
    readonly thread_id: Ids.ThreadId
    readonly events: ReadonlyArray<Event.Event>
    readonly notice?: string
    readonly active_orb?: ActiveOrb
    readonly context_tokens?: number
    readonly context_window?: number
  },
): ViewState => {
  const base = initialSeed({
    thread_id: input.thread_id,
    workspace_path: state.workspace_path,
    mode: state.mode,
    ...(state.user_id === undefined ? {} : { user_id: state.user_id }),
    ...(input.active_orb === undefined ? {} : { active_orb: input.active_orb }),
    ...(input.context_tokens === undefined ? {} : { context_tokens: input.context_tokens }),
    ...(input.context_window === undefined ? {} : { context_window: input.context_window }),
  })
  const next = fromEvents(
    {
      thread_id: input.thread_id,
      workspace_path: state.workspace_path,
      mode: state.mode,
      ...(state.user_id === undefined ? {} : { user_id: state.user_id }),
      events: input.events,
      ...(input.active_orb === undefined ? {} : { active_orb: input.active_orb }),
      ...(input.context_tokens === undefined ? {} : { context_tokens: input.context_tokens }),
      ...(input.context_window === undefined ? {} : { context_window: input.context_window }),
    },
    base,
  )
  return input.notice === undefined ? next : withNotice(next, input.notice)
}

export const withNotice = (state: ViewState, notice: string): ViewState => ({
  ...state,
  notice,
  palette_open: false,
  palette: closedPalette,
  shortcuts_open: false,
})

export const beginConnecting = (state: ViewState): ViewState => ({
  ...withoutNotice(state),
  connecting_ticks: connectingTicks,
})

export const withPalette = (state: ViewState): ViewState => ({
  ...state,
  palette_open: true,
  palette: { open: true, query: "", selected: 0 },
  shortcuts_open: false,
  notice: `Command palette: /threads, /relaunch, /help, /welcome, /credits, /version, /exit, /ast-grep, /mcp, /mode rush, /mode smart, /mode deep1, /mode deep2, /mode deep3`,
})

export const toggleRemoteArm = (state: ViewState): ViewState => ({
  ...state,
  remoteArm: { ...state.remoteArm, enabled: !state.remoteArm.enabled },
})

export const withRemoteProject = (state: ViewState, projectName: string): ViewState => ({
  ...state,
  remoteArm: { ...state.remoteArm, project_name: projectName },
})

export const withRemoteArm = (state: ViewState, remoteArm: RemoteArmState): ViewState => ({
  ...state,
  remoteArm,
})

export const withPresence = (state: ViewState, presence: Remote.PresencePayload): ViewState => {
  if (presence.thread_id !== state.thread_id) return state
  return {
    ...state,
    presence: presence.users
      .filter((user) => state.user_id === undefined || user.user_id !== state.user_id)
      .map((user) => ({ user_id: user.user_id, state: user.state })),
  }
}

export const presenceStatusLabel = (state: ViewState): string | undefined => {
  if (state.presence.length === 0) return undefined
  const typing = state.presence.find((user) => user.state === "typing")
  if (typing !== undefined) return `◈ ${typing.user_id} is typing…`
  const first = state.presence[0]
  if (first === undefined) return undefined
  return state.presence.length === 1 ? `◈ ${first.user_id}` : `◈ ${first.user_id} +${state.presence.length - 1}`
}

export const messageDisplayText = (state: ViewState, message: ThreadMessage): string =>
  message.role === "user" &&
  message.user_id !== undefined &&
  (state.user_id === undefined || message.user_id !== state.user_id)
    ? `${message.user_id} › ${message.text}`
    : message.text

const nextReasoningMode = (mode: Config.Mode): Config.Mode =>
  mode === "deep1" ? "deep2" : mode === "deep2" ? "deep3" : mode === "deep3" ? "deep1" : mode

const withoutNotice = (state: ViewState): ViewState => {
  const { notice: _notice, ...rest } = state
  return rest
}

const initialContextUsage = (input: Input) => {
  if (input.context_tokens === undefined || input.context_window === undefined) return {}
  return { context_usage: contextUsage(input.context_tokens, input.context_window) }
}

const withContextUsageFromTurn = (state: ViewState, event: Event.TurnCompleted): ViewState => {
  const tokens = event.data.usage?.input_tokens
  if (tokens === undefined) return state
  const window = contextWindowForTurn(state, event)
  if (window === undefined) return state
  return { ...state, context_usage: contextUsage(tokens, window) }
}

const contextWindowForTurn = (state: ViewState, event: Event.TurnCompleted): number | undefined =>
  event.data.model === undefined ? state.context_usage?.window : ModelInfo.modelInfo(event.data.model).context_window

const contextUsage = (tokens: number, window: number): ContextUsage => {
  const percent = Math.min(100, Math.max(0, Math.round((tokens / window) * 100)))
  return {
    tokens,
    window,
    percent,
    tone: percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal",
  }
}

const contextPrunedSubtitle = (event: Event.ContextPruned): string =>
  `${event.data.tool_call_ids.length} tools · ${event.data.estimated_tokens_freed} tokens`

export const insertText = (state: ViewState, text: string): ViewState => {
  const { text: current, cursor } = state.input
  const next = `${current.slice(0, cursor)}${text}${current.slice(cursor)}`
  return {
    ...state,
    input: { ...state.input, text: next, cursor: cursor + text.length },
    history_index: -1,
    nav_index: -1,
  }
}

export const insertImageAttachment = (state: ViewState, path: string): ViewState => {
  const token = `@${path}`
  const text = `[Image ${imageAttachmentCount(state.input) + 1}]`
  const next = insertText(state, `${token} `)
  return {
    ...next,
    input: { ...next.input, attachments: [...state.input.attachments, { kind: "image", token, text, path }] },
  }
}

export const insertPastedText = (state: ViewState, text: string): ViewState => {
  const token = pastedTextToken(state.input.attachments.length)
  const label = pastedTextLabel(pastedTextAttachmentCount(state.input) + 1, text)
  const next = insertText(state, token)
  return {
    ...next,
    input: {
      ...next.input,
      attachments: [...state.input.attachments, { kind: "paste", token, text: label, value: text }],
    },
  }
}

export const submitText = (state: ViewState): string =>
  submitInputParts(state)
    .map((part) => part.text)
    .join("")

export const submitInputParts = (state: ViewState): ReadonlyArray<SubmittedInputPart> => {
  const parts: Array<SubmittedInputPart> = []
  const text = state.input.text
  let index = 0
  while (index < text.length) {
    const match = nextAttachmentMatch(state.input.attachments, text, index)
    if (match === undefined) {
      pushSubmittedText(parts, text.slice(index))
      break
    }
    if (match.index > index) pushSubmittedText(parts, text.slice(index, match.index))
    if (match.attachment.kind === "image")
      parts.push({ type: "image", path: match.attachment.path, text: match.attachment.text })
    else pushSubmittedText(parts, match.attachment.value)
    index = match.index + match.attachment.token.length
  }
  return parts
}

export const displayInputText = (input: InputBuffer): string => {
  let text = input.text
  for (const attachment of input.attachments) {
    if (text.includes(attachment.token)) text = text.replaceAll(attachment.token, attachment.text)
  }
  return text
}

export const hasCollapsedPaste = (input: InputBuffer): boolean =>
  input.attachments.some((attachment) => attachment.kind === "paste" && input.text.includes(attachment.token))

const imageAttachmentCount = (input: InputBuffer): number =>
  input.attachments.filter((attachment) => attachment.kind === "image").length

const pastedTextAttachmentCount = (input: InputBuffer): number =>
  input.attachments.filter((attachment) => attachment.kind === "paste").length

const pastedTextToken = (index: number): string => String.fromCharCode(0xe000 + index)

const pastedTextLabel = (index: number, text: string): string => {
  const lines = text.split(/\r\n|\r|\n/).length
  return lines > 1 ? `[Pasted text #${index} +${lines} lines]` : `[Pasted text #${index}]`
}

const nextAttachmentMatch = (
  attachments: ReadonlyArray<InputAttachment>,
  text: string,
  start: number,
): { readonly attachment: InputAttachment; readonly index: number } | undefined => {
  let best: { readonly attachment: InputAttachment; readonly index: number } | undefined
  for (const attachment of attachments) {
    const index = text.indexOf(attachment.token, start)
    if (index >= 0 && (best === undefined || index < best.index)) best = { attachment, index }
  }
  return best
}

const pushSubmittedText = (parts: Array<SubmittedInputPart>, text: string): void => {
  if (text.length === 0) return
  const previous = parts.at(-1)
  if (previous?.type === "text") parts[parts.length - 1] = { type: "text", text: previous.text + text }
  else parts.push({ type: "text", text })
}

export const backspace = (state: ViewState): ViewState => {
  const { text, cursor } = state.input
  if (cursor === 0) return state
  const next = `${text.slice(0, cursor - 1)}${text.slice(cursor)}`
  return { ...state, input: { ...state.input, text: next, cursor: cursor - 1 } }
}

export const deleteForward = (state: ViewState): ViewState => {
  const { text, cursor } = state.input
  if (cursor >= text.length) return state
  return { ...state, input: { ...state.input, text: `${text.slice(0, cursor)}${text.slice(cursor + 1)}`, cursor } }
}

export const deleteWordBackward = (state: ViewState): ViewState => {
  const { text, cursor } = state.input
  const end = clampCursor(text, cursor)
  const start = wordStartBefore(text, end)
  if (start === end) return state
  return { ...state, input: { ...state.input, text: `${text.slice(0, start)}${text.slice(end)}`, cursor: start } }
}

export const deleteWordForward = (state: ViewState): ViewState => {
  const { text, cursor } = state.input
  const start = clampCursor(text, cursor)
  const end = wordEndAfter(text, start)
  if (start === end) return state
  return { ...state, input: { ...state.input, text: `${text.slice(0, start)}${text.slice(end)}`, cursor: start } }
}

export const deleteToLineStart = (state: ViewState): ViewState => {
  const { text, cursor } = state.input
  const end = clampCursor(text, cursor)
  const start = lineStartBefore(text, end)
  if (start === end) return state
  return { ...state, input: { ...state.input, text: `${text.slice(0, start)}${text.slice(end)}`, cursor: start } }
}

export const deleteToLineEnd = (state: ViewState): ViewState => {
  const { text, cursor } = state.input
  const start = clampCursor(text, cursor)
  const end = lineEndAfter(text, start)
  if (start === end) return state
  return { ...state, input: { ...state.input, text: `${text.slice(0, start)}${text.slice(end)}`, cursor: start } }
}

export const moveCursorLeft = (state: ViewState): ViewState => ({
  ...state,
  input: { ...state.input, cursor: Math.max(0, state.input.cursor - 1) },
})

export const moveCursorRight = (state: ViewState): ViewState => ({
  ...state,
  input: { ...state.input, cursor: Math.min(state.input.text.length, state.input.cursor + 1) },
})

export const moveCursorHome = (state: ViewState): ViewState => ({ ...state, input: { ...state.input, cursor: 0 } })

export const moveCursorEnd = (state: ViewState): ViewState => ({
  ...state,
  input: { ...state.input, cursor: state.input.text.length },
})

export const moveWordLeft = (state: ViewState): ViewState => ({
  ...state,
  input: {
    ...state.input,
    cursor: wordStartBefore(state.input.text, clampCursor(state.input.text, state.input.cursor)),
  },
})

export const moveWordRight = (state: ViewState): ViewState => ({
  ...state,
  input: { ...state.input, cursor: wordEndAfter(state.input.text, clampCursor(state.input.text, state.input.cursor)) },
})

export const newline = (state: ViewState): ViewState => insertText(state, "\n")

const clampCursor = (text: string, cursor: number): number => Math.max(0, Math.min(text.length, cursor))

const isSpace = (text: string): boolean => /\s/.test(text)

const wordStartBefore = (text: string, cursor: number): number => {
  let index = cursor
  while (index > 0 && isSpace(text[index - 1] ?? "")) index -= 1
  while (index > 0 && !isSpace(text[index - 1] ?? "")) index -= 1
  return index
}

const wordEndAfter = (text: string, cursor: number): number => {
  let index = cursor
  while (index < text.length && isSpace(text[index] ?? "")) index += 1
  while (index < text.length && !isSpace(text[index] ?? "")) index += 1
  return index
}

const lineStartBefore = (text: string, cursor: number): number => {
  const index = text.slice(0, cursor).lastIndexOf("\n")
  return index === -1 ? 0 : index + 1
}

const lineEndAfter = (text: string, cursor: number): number => {
  const index = text.indexOf("\n", cursor)
  return index === -1 ? text.length : index
}

export const clearInput = (state: ViewState): ViewState =>
  setFocus({ ...state, input: emptyInput, history_index: -1, nav_index: -1 }, undefined)

export const pushHistory = (state: ViewState, text: string): ViewState => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ...state, history_index: -1 }
  const history = state.history[state.history.length - 1] === trimmed ? state.history : [...state.history, trimmed]
  return { ...state, history, history_index: -1 }
}

export const historyPrev = (state: ViewState): ViewState => {
  if (state.history.length === 0) return state
  const index = state.history_index === -1 ? state.history.length - 1 : Math.max(0, state.history_index - 1)
  const text = state.history[index] ?? ""
  return { ...state, history_index: index, input: { text, cursor: text.length, attachments: [] } }
}

export const historyNext = (state: ViewState): ViewState => {
  if (state.history_index === -1) return state
  const index = state.history_index + 1
  if (index >= state.history.length) return { ...state, history_index: -1, input: emptyInput }
  const text = state.history[index] ?? ""
  return { ...state, history_index: index, input: { text, cursor: text.length, attachments: [] } }
}

export const userMessageTexts = (state: ViewState): ReadonlyArray<string> =>
  state.entries.flatMap((entry) =>
    entry.kind === "message" && entry.message.role === "user" ? [entry.message.text] : [],
  )

export const navPrevMessage = (state: ViewState): ViewState => {
  const count = userMessageTexts(state).length
  if (count === 0) return state
  const next = state.nav_index === -1 ? 0 : Math.min(state.nav_index + 1, count - 1)
  return { ...state, nav_index: next }
}

export const navNextMessage = (state: ViewState): ViewState =>
  state.nav_index <= 0 ? { ...state, nav_index: -1 } : { ...state, nav_index: state.nav_index - 1 }

export const selectedNavId = (state: ViewState): string | undefined => {
  if (state.nav_index < 0) return undefined
  const userEntries = state.entries.filter((entry) => entry.kind === "message" && entry.message.role === "user")
  const entry = userEntries[userEntries.length - 1 - state.nav_index]
  return entry !== undefined && entry.kind === "message" ? entry.message.id : undefined
}

export const editNavMessage = (state: ViewState): ViewState => {
  const texts = userMessageTexts(state)
  if (state.nav_index < 0 || state.nav_index >= texts.length) return state
  const text = texts[texts.length - 1 - state.nav_index] ?? ""
  return { ...state, nav_index: -1, input: { text, cursor: text.length, attachments: [] } }
}

export const clearNav = (state: ViewState): ViewState => (state.nav_index === -1 ? state : { ...state, nav_index: -1 })

const focusableCount = (state: ViewState) => state.cards.length

const setFocus = (state: ViewState, index: number | undefined): ViewState => {
  const { focus_index: _drop, ...rest } = state
  return index === undefined ? rest : { ...rest, focus_index: index }
}

export const focusPrev = (state: ViewState): ViewState => {
  const count = focusableCount(state)
  if (count === 0) return setFocus(state, undefined)
  if (state.focus_index === undefined) return setFocus(state, count - 1)
  return setFocus(state, Math.max(0, state.focus_index - 1))
}

export const focusNext = (state: ViewState): ViewState => {
  const count = focusableCount(state)
  if (count === 0) return setFocus(state, undefined)
  if (state.focus_index === undefined) return setFocus(state, 0)
  if (state.focus_index >= count - 1) return setFocus(state, undefined)
  return setFocus(state, state.focus_index + 1)
}

export const focusedCard = (state: ViewState): Card | undefined =>
  state.focus_index === undefined ? undefined : state.cards[state.focus_index]

export const toggleCard = (state: ViewState, id: string): ViewState => {
  const card = state.cards.find((candidate) => candidate.id === id)
  if (card === undefined || !isCardExpandable(card)) return state
  const next = new Set(state.expanded_ids)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return { ...state, expanded_ids: next }
}

export const toggleToolGroup = (state: ViewState): ViewState => ({
  ...state,
  tool_group_expanded: !state.tool_group_expanded,
})

export const toggleDetails = (state: ViewState): ViewState => {
  const card = focusedCard(state)
  if (card !== undefined) return toggleCard(state, card.id)
  return {
    ...state,
    details_expanded: !state.details_expanded,
    thinking: { ...state.thinking, visible: !state.thinking.visible },
  }
}

export const isCardCollapsed = (state: ViewState, card: Card): boolean => {
  if (!isCardExpandable(card)) return true
  if (state.expanded_ids.has(card.id)) return false
  if (state.details_expanded) return false
  return card.collapsed
}

export const isCardExpandable = (card: Card): boolean =>
  card.expandable !== false && card.content !== undefined && isContentExpandable(card.content)

const isContentExpandable = (content: CardContent): boolean => content.kind === "pierre-diff" || content.text.length > 0

export const enqueueMessage = (state: ViewState, message: string): ViewState => ({
  ...state,
  queued: [...state.queued, message],
  queue_selected: -1,
})

export const clearQueuedMessages = (state: ViewState): ViewState => ({ ...state, queued: [], queue_selected: -1 })

export const dequeueMessage = (state: ViewState): { readonly next?: string; readonly state: ViewState } => {
  const [next, ...rest] = state.queued
  if (next === undefined) return { state }
  return { next, state: { ...state, queued: rest, queue_selected: -1 } }
}

export const queueUp = (state: ViewState): ViewState => {
  const count = state.queued.length
  if (count === 0) return state
  const next = state.queue_selected === -1 ? count - 1 : Math.max(0, state.queue_selected - 1)
  return { ...state, queue_selected: next }
}

export const queueDown = (state: ViewState): ViewState => {
  const count = state.queued.length
  if (count === 0 || state.queue_selected === -1) return state
  const next = state.queue_selected + 1
  return { ...state, queue_selected: next >= count ? -1 : next }
}

export const dequeueSelected = (state: ViewState): ViewState => {
  const index = state.queue_selected
  if (index < 0 || index >= state.queued.length) return state
  const queued = [...state.queued.slice(0, index), ...state.queued.slice(index + 1)]
  const selected = queued.length === 0 ? -1 : Math.min(index, queued.length - 1)
  return { ...state, queued, queue_selected: selected }
}

export const selectedQueued = (state: ViewState): string | undefined =>
  state.queue_selected >= 0 ? state.queued[state.queue_selected] : undefined

export const promoteSelectedOrNextQueued = (state: ViewState): ViewState => {
  if (state.queued.length === 0) return { ...state, queue_selected: -1 }
  const index = state.queue_selected < 0 ? 0 : Math.min(state.queue_selected, state.queued.length - 1)
  const selected = state.queued[index]
  if (selected === undefined) return { ...state, queue_selected: -1 }
  const queued = [selected, ...state.queued.slice(0, index), ...state.queued.slice(index + 1)]
  return { ...state, queued, queue_selected: -1 }
}

export const withReasoningDelta = (state: ViewState, text: string): ViewState => ({
  ...state,
  generated_text_chars: state.generated_text_chars + text.length,
  thinking: { ...state.thinking, text: `${state.thinking.text}${text}` },
})

const appendStreamingText = (current: string, next: string): string => {
  const text = `${current}${next}`
  if (text.length <= maxStreamingTextChars) return text
  const start = text.length - maxStreamingTextChars
  const newlineIndex = text.indexOf("\n", start)
  return newlineIndex >= 0 && newlineIndex < text.length - 1 ? text.slice(newlineIndex + 1) : text.slice(start)
}

export const toggleThinking = (state: ViewState): ViewState => ({
  ...state,
  thinking: { ...state.thinking, visible: !state.thinking.visible },
})

export const openPalette = (state: ViewState): ViewState => ({
  ...withoutNotice(state),
  palette_open: true,
  palette: { open: true, query: "", selected: 0 },
  filepicker: closedFilePicker,
  threadswitcher: closedThreadSwitcher,
  shortcuts_open: false,
})

export const closePalette = (state: ViewState): ViewState => ({
  ...state,
  palette_open: false,
  palette: closedPalette,
})

export const paletteInsert = (state: ViewState, text: string): ViewState => ({
  ...state,
  palette: { ...state.palette, query: `${state.palette.query}${text}`, selected: 0 },
})

export const paletteBackspace = (state: ViewState): ViewState => ({
  ...state,
  palette: { ...state.palette, query: state.palette.query.slice(0, -1), selected: 0 },
})

export const paletteMove = (state: ViewState, delta: number, count: number): ViewState => {
  if (count <= 0) return { ...state, palette: { ...state.palette, selected: 0 } }
  const selected = (((state.palette.selected + delta) % count) + count) % count
  return { ...state, palette: { ...state.palette, selected } }
}

const familyOf = (mode: Config.Mode): ModePickerFamily =>
  mode === "rush" ? "rush" : mode === "smart" ? "smart" : "deep"

export const openModePicker = (state: ViewState): ViewState => {
  if (modeLocked(state)) return state
  return {
    ...withoutNotice(state),
    modepicker: { open: true, selected: Math.max(0, modePickerFamilies.indexOf(familyOf(state.mode))) },
  }
}

export const closeModePicker = (state: ViewState): ViewState => ({
  ...state,
  modepicker: closedModePicker,
})

export const modePickerMove = (state: ViewState, delta: number): ViewState => {
  if (modeLocked(state)) return state
  const count = modePickerFamilies.length
  const selected = (((state.modepicker.selected + delta) % count) + count) % count
  return { ...state, modepicker: { ...state.modepicker, selected } }
}

export const modePickerApply = (state: ViewState): ViewState => {
  if (modeLocked(state)) return state
  const family = modePickerFamilies[state.modepicker.selected] ?? "smart"
  if (family === "deep") return withMode(state, deepModeForTier(state.deep_tier))
  return withMode(state, family)
}

export const openShortcuts = (state: ViewState): ViewState => ({
  ...withoutNotice(state),
  shortcuts_open: true,
  palette_open: false,
  palette: closedPalette,
  filepicker: closedFilePicker,
  threadswitcher: closedThreadSwitcher,
})

export const closeShortcuts = (state: ViewState): ViewState => ({ ...state, shortcuts_open: false })

export const openFilePicker = (state: ViewState, files: ReadonlyArray<string>): ViewState => ({
  ...withoutNotice(state),
  palette_open: false,
  palette: closedPalette,
  filepicker: {
    open: true,
    query: "",
    selected: 0,
    kind: "file",
    items: files.map((file) => ({ label: file, insert: file })),
  },
  threadswitcher: closedThreadSwitcher,
})

export const openThreadPicker = (state: ViewState, items: ReadonlyArray<PickerItem>): ViewState => ({
  ...withoutNotice(state),
  palette_open: false,
  palette: closedPalette,
  filepicker: { open: true, query: "", selected: 0, kind: "thread", items },
  threadswitcher: closedThreadSwitcher,
})

export const closeFilePicker = (state: ViewState): ViewState => ({ ...state, filepicker: closedFilePicker })

export const openThreadSwitcher = (state: ViewState, items: ReadonlyArray<ThreadSwitcherItem>): ViewState => ({
  ...withoutNotice(state),
  palette_open: false,
  palette: closedPalette,
  filepicker: closedFilePicker,
  threadswitcher: { open: true, query: "", selected: 0, items },
  shortcuts_open: false,
})

export const closeThreadSwitcher = (state: ViewState): ViewState => ({ ...state, threadswitcher: closedThreadSwitcher })

export const threadSwitcherInsert = (state: ViewState, text: string): ViewState => ({
  ...state,
  threadswitcher: { ...state.threadswitcher, query: `${state.threadswitcher.query}${text}`, selected: 0 },
})

export const threadSwitcherBackspace = (state: ViewState): ViewState => ({
  ...state,
  threadswitcher: { ...state.threadswitcher, query: state.threadswitcher.query.slice(0, -1), selected: 0 },
})

export const threadSwitcherMove = (state: ViewState, delta: number, count: number): ViewState => {
  if (count <= 0) return { ...state, threadswitcher: { ...state.threadswitcher, selected: 0 } }
  const selected = (((state.threadswitcher.selected + delta) % count) + count) % count
  return { ...state, threadswitcher: { ...state.threadswitcher, selected } }
}

export const selectedThreadSwitcherItem = (state: ViewState): ThreadSwitcherItem | undefined =>
  filteredThreadSwitcherItems(state)[state.threadswitcher.selected]

export const threadSwitcherPreviewLoading = (state: ViewState, threadId: Ids.ThreadId): ViewState =>
  updateThreadSwitcherItem(state, threadId, (item) => ({ ...item, preview_state: { status: "loading" } }))

export const threadSwitcherPreviewReady = (
  state: ViewState,
  threadId: Ids.ThreadId,
  previewState: ViewState,
): ViewState =>
  updateThreadSwitcherItem(state, threadId, (item) => ({
    ...item,
    preview_state: { status: "ready", state: previewState },
  }))

export const threadSwitcherPreviewFailed = (state: ViewState, threadId: Ids.ThreadId, message: string): ViewState =>
  updateThreadSwitcherItem(state, threadId, (item) => ({
    ...item,
    preview_state: { status: "failed", message },
  }))

const updateThreadSwitcherItem = (
  state: ViewState,
  threadId: Ids.ThreadId,
  update: (item: ThreadSwitcherItem) => ThreadSwitcherItem,
): ViewState => ({
  ...state,
  threadswitcher: {
    ...state.threadswitcher,
    items: state.threadswitcher.items.map((item) => (item.thread_id === threadId ? update(item) : item)),
  },
})

export const filePickerInsert = (state: ViewState, text: string): ViewState => ({
  ...state,
  filepicker: { ...state.filepicker, query: `${state.filepicker.query}${text}`, selected: 0 },
})

export const filePickerBackspace = (state: ViewState): ViewState => ({
  ...state,
  filepicker: { ...state.filepicker, query: state.filepicker.query.slice(0, -1), selected: 0 },
})

export const filePickerMove = (state: ViewState, delta: number, count: number): ViewState => {
  if (count <= 0) return { ...state, filepicker: { ...state.filepicker, selected: 0 } }
  const selected = (((state.filepicker.selected + delta) % count) + count) % count
  return { ...state, filepicker: { ...state.filepicker, selected } }
}

export const filteredPickerItems = (state: ViewState): ReadonlyArray<PickerItem> => {
  const needle = state.filepicker.query.trim().toLowerCase()
  const matches =
    needle.length === 0
      ? state.filepicker.items
      : state.filepicker.items.filter((item) => item.label.toLowerCase().includes(needle))
  return matches.slice(0, 50)
}

export const filteredFiles = (state: ViewState): ReadonlyArray<string> =>
  filteredPickerItems(state).map((item) => item.label)

export const filteredThreadSwitcherItems = (state: ViewState): ReadonlyArray<ThreadSwitcherItem> => {
  const needle = state.threadswitcher.query.trim().toLowerCase()
  const matches =
    needle.length === 0
      ? state.threadswitcher.items
      : state.threadswitcher.items.filter(
          (item) =>
            item.title.toLowerCase().includes(needle) ||
            item.preview.toLowerCase().includes(needle) ||
            item.thread_id.toLowerCase().includes(needle),
        )
  return matches.slice(0, 50)
}

export const acceptSelected = (state: ViewState): ViewState => {
  const item = filteredPickerItems(state)[state.filepicker.selected]
  return item === undefined ? closeFilePicker(state) : closeFilePicker(insertText(state, `@${item.insert} `))
}

export const tickSpinner = (state: ViewState): ViewState => ({
  ...state,
  spinner_index: (state.spinner_index + 1) % spinnerFrames.length,
  connecting_ticks: state.connecting_ticks > 0 ? state.connecting_ticks - 1 : 0,
  mode_switch_ticks: state.mode_switch_ticks > 0 ? state.mode_switch_ticks - 1 : 0,
})

const tick = tickSpinner

const applyMessage = (state: ViewState, event: Event.MessageAdded): ViewState => {
  const message = event.data.message
  const text = messageText(message)
  if (text.length === 0) return state
  const userId = messageUserId(message)
  const entry: ThreadMessage = {
    id: message.id,
    role: message.role,
    text,
    ...(userId === undefined ? {} : { user_id: userId }),
  }
  return {
    ...state,
    streaming_text: message.role === "assistant" ? "" : state.streaming_text,
    messages: [...state.messages, entry],
    entries: [...state.entries, { kind: "message", message: entry }],
  }
}

const messageUserId = (message: Message.Message): Ids.UserId | undefined => {
  const value = message.metadata?.user_id
  return typeof value === "string" ? Ids.UserId.make(value) : undefined
}

const skillCard = (event: Event.SkillLoaded): Card => ({
  id: event.id,
  kind: "skill",
  title: `Skill loaded: ${event.data.name}`,
  subtitle: event.data.source,
  status: "info",
  collapsed: true,
  content: {
    kind: "text",
    text: [
      event.data.description,
      `File: ${event.data.skill_file}`,
      `Resources: ${event.data.resource_paths.join(", ")}`,
    ].join("\n"),
  },
})

const subagentCard = (event: Event.SubagentCompleted): Card => ({
  id: event.id,
  kind: "subagent",
  title: `Subagent: ${event.data.name}`,
  subtitle: event.data.status,
  status: event.data.status === "completed" ? "success" : event.data.status === "failed" ? "error" : "info",
  collapsed: true,
  content: {
    kind: "text",
    text: [event.data.summary, ...event.data.evidence.map((evidence) => `- ${evidence}`)].join("\n"),
  },
})

const toolCard = (state: ViewState, event: Event.ToolCallRequested): Card => {
  const text = toolRequestBody(event.data.call.name, event.data.call.input)
  const target = fileTarget(state.workspace_path, event.data.call.input)
  return {
    id: event.data.call.id,
    kind: "tool",
    title: toolRequestTitle(state.workspace_path, event.data.call.name, event.data.call.input),
    subtitle: "",
    status: "running",
    collapsed: true,
    ...(text === undefined ? {} : { content: textContent(text) }),
    tool_name: event.data.call.name,
    expandable: !isReadTool(event.data.call.name) && text !== undefined && text.length > 0,
    ...(target === undefined
      ? {}
      : { path: target.path, ...(target.range === undefined ? {} : { range: target.range }) }),
  }
}

const toolInputCard = (event: Event.ToolCallInputStarted): Card => ({
  id: event.data.id,
  kind: "tool",
  title: event.data.name,
  subtitle: "",
  status: "info",
  collapsed: true,
  content: textContent(""),
  tool_name: event.data.name,
  expandable: false,
})

const applyToolResult = (state: ViewState, event: Event.ToolCallCompleted): ViewState => {
  const result = event.data.result
  const existing = state.cards.find((card) => card.id === result.id)
  const toolName = existing?.tool_name ?? result.name
  const status = result.status === "success" ? "success" : "error"
  const errorBody = result.error?.message ?? "Tool failed"
  const target = fileTarget(state.workspace_path, result.output) ?? cardTarget(existing)
  if (isReadTool(toolName)) {
    return updateCard(state, {
      id: result.id,
      kind: "tool",
      title: existing?.title ?? toolReadTitle(state.workspace_path, result.output),
      subtitle: result.status === "success" ? "" : errorBody,
      status,
      collapsed: true,
      tool_name: toolName,
      expandable: false,
      ...(target === undefined
        ? {}
        : { path: target.path, ...(target.range === undefined ? {} : { range: target.range }) }),
    })
  }
  const diff = result.status === "success" ? extractPierreDiff(state.workspace_path, result.output) : undefined
  if (diff !== undefined) {
    return updateCard(state, {
      id: result.id,
      kind: "tool",
      title: editedTitle(toolName, diff),
      subtitle: "",
      status,
      collapsed: true,
      content: { kind: "pierre-diff", file_diff: diff.file_diff },
      tool_name: toolName,
      expandable: true,
      path: diff.path,
    })
  }
  const text = result.status === "success" ? toolResultBody(toolName, result.output) : errorBody
  return updateCard(state, {
    id: result.id,
    kind: "tool",
    title: existing?.title ?? toolResultTitle(state.workspace_path, toolName, result.output),
    subtitle: "",
    status,
    collapsed: true,
    ...(text === undefined ? {} : { content: textContent(text) }),
    tool_name: toolName,
    expandable: text !== undefined && text.length > 0,
    ...(target === undefined
      ? {}
      : { path: target.path, ...(target.range === undefined ? {} : { range: target.range }) }),
  })
}

const errorCard = (event: Event.TurnFailed): Card => ({
  id: event.id,
  kind: "error",
  title: "Turn failed",
  subtitle: event.data.error.kind,
  status: "error",
  collapsed: false,
  content: textContent(event.data.error.message),
})

const systemCard = (title: string, subtitle: string, id: string): Card => ({
  id,
  kind: "system",
  title,
  subtitle,
  status: "info",
  collapsed: true,
})

const upsertCard = (cards: ReadonlyArray<Card>, card: Card): ReadonlyArray<Card> => {
  const index = cards.findIndex((existing) => existing.id === card.id)
  if (index < 0) return [...cards, card]
  return cards.map((existing, current) => (current === index ? card : existing))
}

const upsertCardEntry = (entries: ReadonlyArray<TranscriptEntry>, card: Card): ReadonlyArray<TranscriptEntry> => {
  const index = entries.findIndex((entry) => entry.kind === "card" && entry.card.id === card.id)
  if (index < 0) return [...entries, { kind: "card", card }]
  return entries.map((entry, current) => (current === index ? { kind: "card", card } : entry))
}

const pushCard = (state: ViewState, card: Card): ViewState => ({
  ...state,
  cards: [...state.cards, card],
  entries: [...state.entries, { kind: "card", card }],
})

const updateCard = (state: ViewState, card: Card): ViewState => ({
  ...state,
  cards: upsertCard(state.cards, card),
  entries: upsertCardEntry(state.entries, card),
})

export const withSystemCard = (
  state: ViewState,
  input: { readonly id: string; readonly title: string; readonly subtitle?: string },
): ViewState => updateCard(state, systemCard(input.title, input.subtitle ?? "", input.id))

const messageText = (message: Message.Message) => Message.displayText(message)

const jsonSummary = (value: Common.JsonValue | undefined) => {
  if (value === undefined) return ""
  const text = JSON.stringify(value, undefined, 2)
  if (text.length <= 800) return text
  return `${text.slice(0, 800)}\n… truncated`
}

const toolRequestTitle = (workspacePath: string, name: string, input: Common.JsonValue): string => {
  const lower = name.toLowerCase()
  if (isReadTool(name)) return toolReadTitle(workspacePath, input)
  if (lower === "write") return withTarget("Write", displayPathFrom(workspacePath, input))
  if (lower.includes("edit") || lower === "apply_patch")
    return withTarget("Edit", displayPathFrom(workspacePath, input))
  if (isCommandTool(name)) {
    const command = stringField(input, "command") ?? stringField(input, "cmd") ?? stringField(input, "script")
    return command === undefined ? "Run command" : `$ ${oneLine(command, 160)}`
  }
  if (lower.includes("grep")) {
    const pattern = stringField(input, "pattern") ?? stringField(input, "query")
    const path = displayPathFrom(workspacePath, input)
    return ["Grep", path, pattern === undefined ? undefined : quoted(oneLine(pattern, 80))]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(" ")
  }
  if (isSearchTool(name)) {
    const query = searchQuery(input)
    return query === undefined ? "Search" : `Search ${oneLine(query, 120)}`
  }
  return withTarget(humanToolName(name), displayPathFrom(workspacePath, input) ?? searchQuery(input))
}

const toolReadTitle = (workspacePath: string, value: Common.JsonValue | undefined): string => {
  const path = displayPathFrom(workspacePath, value)
  return path === undefined ? "Read" : `Read ${path}`
}

const toolRequestBody = (name: string, input: Common.JsonValue): string | undefined => {
  if (isReadTool(name)) return undefined
  if (isCommandTool(name)) {
    const command = stringField(input, "command") ?? stringField(input, "cmd") ?? stringField(input, "script")
    if (command !== undefined) return command
  }
  const text = jsonSummary(input)
  return text.length === 0 ? undefined : text
}

const toolResultTitle = (workspacePath: string, name: string, output: Common.JsonValue | undefined): string =>
  withTarget(humanToolName(name), displayPathFrom(workspacePath, output) ?? searchQuery(output))

const toolResultBody = (name: string, output: Common.JsonValue | undefined): string | undefined => {
  if (output === undefined) return undefined
  if (typeof output === "string") return output.length === 0 ? undefined : limitBlock(output)
  if (isJsonObject(output)) {
    const stdout = stringField(output, "stdout")
    const stderr = stringField(output, "stderr")
    if (stdout !== undefined || stderr !== undefined) {
      const chunks = [stdout, stderr].filter((chunk): chunk is string => chunk !== undefined && chunk.length > 0)
      return limitBlock(chunks.join("\n").trimEnd())
    }
    const results = arrayField(output, "results") ?? arrayField(output, "matches")
    if (results !== undefined) return limitBlock(renderResultList(results))
    const content = isReadTool(name)
      ? undefined
      : (stringField(output, "content") ?? stringField(output, "text") ?? stringField(output, "summary"))
    if (content !== undefined && content.length > 0) return limitBlock(content)
  }
  const text = jsonSummary(output)
  return text.length === 0 ? undefined : text
}

const renderResultList = (items: ReadonlyArray<Common.JsonValue>): string => {
  const rows = items.slice(0, 30).map(renderResultItem)
  if (items.length > rows.length) rows.push(`… ${items.length - rows.length} more results`)
  return rows.join("\n")
}

const renderResultItem = (item: Common.JsonValue): string => {
  if (!isJsonObject(item)) return jsonSummary(item)
  const path = pathFrom(item) ?? stringField(item, "title") ?? stringField(item, "name")
  const line = numberField(item, "line") ?? numberField(item, "line_number") ?? numberField(item, "start_line")
  const text =
    stringField(item, "text") ??
    stringField(item, "snippet") ??
    stringField(item, "content") ??
    stringField(item, "summary")
  const label = path === undefined ? undefined : line === undefined ? path : `${path}:${line}`
  if (label !== undefined && text !== undefined) return `${label}\n  ${oneLine(text, 220)}`
  if (label !== undefined) return label
  if (text !== undefined) return text
  return jsonSummary(item)
}

interface RenderedDiff {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  readonly file_diff: Common.JsonValue
}

const extractPierreDiff = (workspacePath: string, value: Common.JsonValue | undefined): RenderedDiff | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractPierreDiff(workspacePath, item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isJsonObject(value)) return undefined
  if (isPierreDiff(value)) return renderPierreDiff(workspacePath, value)
  for (const child of Object.values(value)) {
    const found = extractPierreDiff(workspacePath, child)
    if (found !== undefined) return found
  }
  return undefined
}

const isPierreDiff = (value: Record<string, Common.JsonValue>) =>
  value.kind === "diff" && value.renderer === "@pierre/diffs"

const renderPierreDiff = (workspacePath: string, value: Record<string, Common.JsonValue>): RenderedDiff | undefined => {
  const fileDiff = value.file_diff
  if (!isJsonObject(fileDiff)) return undefined
  const path = workspaceRelativePath(workspacePath, stringField(fileDiff, "name") ?? "diff")
  const additions = countChangedLines(fileDiff, "additions")
  const deletions = countChangedLines(fileDiff, "deletions")
  return { path, additions, deletions, file_diff: fileDiff }
}

const countChangedLines = (fileDiff: Record<string, Common.JsonValue>, key: "additions" | "deletions"): number =>
  arrayField(fileDiff, "hunks")
    ?.filter(isJsonObject)
    .reduce(
      (total, hunk) =>
        total +
        (arrayField(hunk, "hunkContent")
          ?.filter(isJsonObject)
          .reduce((inner, content) => inner + (content.type === "change" ? (numberField(content, key) ?? 0) : 0), 0) ??
          0),
      0,
    ) ?? 0

const textContent = (text: string): CardContent => ({ kind: "text", text })

const editedTitle = (name: string, diff: RenderedDiff): string => {
  const verb = name.toLowerCase() === "write" ? "Wrote" : "Edited"
  const stats = `${diff.additions > 0 ? ` +${diff.additions}` : ""}${diff.deletions > 0 ? ` -${diff.deletions}` : ""}`
  return `${verb} ${diff.path}${stats}`
}

const isReadTool = (name: string): boolean => name.toLowerCase() === "read" || name.toLowerCase().endsWith(".read")

const isCommandTool = (name: string): boolean => {
  const lower = name.toLowerCase()
  return lower === "bash" || lower === "shell" || lower.includes("shell") || lower.includes("command")
}

const isSearchTool = (name: string): boolean => {
  const lower = name.toLowerCase()
  return lower.includes("search") || lower.includes("find")
}

const withTarget = (verb: string, target: string | undefined): string =>
  target === undefined || target.length === 0 ? verb : `${verb} ${target}`

const humanToolName = (name: string): string => {
  const words = name
    .replace(/[-_.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  if (words.length === 0) return "Tool"
  return words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ")
}

const pathFrom = (value: Common.JsonValue | undefined): string | undefined => {
  if (!isJsonObject(value)) return undefined
  return stringField(value, "path") ?? stringField(value, "file") ?? stringField(value, "name")
}

const displayPathFrom = (workspacePath: string, value: Common.JsonValue | undefined): string | undefined => {
  const path = pathFrom(value)
  return path === undefined ? undefined : workspaceRelativePath(workspacePath, path)
}

const fileTarget = (
  workspacePath: string,
  value: Common.JsonValue | undefined,
): { readonly path: string; readonly range?: Common.LineRange } | undefined => {
  const path = displayPathFrom(workspacePath, value)
  if (path === undefined) return undefined
  const range = lineRange(value)
  return { path, ...(range === undefined ? {} : { range }) }
}

const cardTarget = (
  card: Card | undefined,
): { readonly path: string; readonly range?: Common.LineRange } | undefined =>
  card?.path === undefined ? undefined : { path: card.path, ...(card.range === undefined ? {} : { range: card.range }) }

const searchQuery = (value: Common.JsonValue | undefined): string | undefined => {
  if (!isJsonObject(value)) return undefined
  const direct = stringField(value, "query") ?? stringField(value, "pattern")
  if (direct !== undefined) return direct
  const queries = arrayField(value, "queries")
  const first = queries?.[0]
  return typeof first === "string" ? first : undefined
}

const lineRange = (value: Common.JsonValue | undefined): Common.LineRange | undefined => {
  if (!isJsonObject(value)) return undefined
  const start =
    numberField(value, "start_line") ?? numberField(isJsonObject(value.range) ? value.range : undefined, "start_line")
  const end =
    numberField(value, "end_line") ?? numberField(isJsonObject(value.range) ? value.range : undefined, "end_line")
  if (start === undefined || end === undefined) return undefined
  return { start_line: start, end_line: end }
}

const workspaceRelativePath = (workspacePath: string, path: string): string => {
  const slashPath = slashify(path)
  if (!isAbsolute(path)) return trimDotPath(slashPath)
  const relativePath = slashify(relative(workspacePath, path))
  if (relativePath.length === 0) return "."
  if (relativePath.startsWith("../") || relativePath === ".." || isAbsolute(relativePath)) return slashPath
  return trimDotPath(relativePath)
}

const slashify = (path: string): string => path.replace(/\\/g, "/")

const trimDotPath = (path: string): string => (path.startsWith("./") ? path.slice(2) : path)

const quoted = (value: string): string => `"${value}"`

const oneLine = (value: string, max: number): string => {
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

const limitBlock = (value: string): string => {
  if (value.length <= 12000) return value
  return `${value.slice(0, 12000)}\n… truncated`
}

const stringField = (value: Common.JsonValue | undefined, key: string): string | undefined => {
  if (!isJsonObject(value)) return undefined
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

const numberField = (value: Common.JsonValue | undefined, key: string): number | undefined => {
  if (!isJsonObject(value)) return undefined
  const field = value[key]
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

const arrayField = (value: Common.JsonValue | undefined, key: string): ReadonlyArray<Common.JsonValue> | undefined => {
  if (!isJsonObject(value)) return undefined
  const field = value[key]
  return Array.isArray(field) ? field : undefined
}

const isJsonObject = (value: Common.JsonValue | undefined): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
