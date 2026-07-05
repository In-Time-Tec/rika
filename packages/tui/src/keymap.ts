import { Data, Equal, Result } from "effect"
import * as Keys from "./keys"

export type Surface = "input" | "palette" | "modepicker" | "overlay"
export type BindingSource = "default" | "workspace" | "user"
export type OverrideSource = Exclude<BindingSource, "default">

export interface Context {
  readonly surface: Surface
  readonly busy: boolean
  readonly inputEmpty: boolean
  readonly trailingBackslash: boolean
  readonly queueSelected: boolean
  readonly navigating: boolean
}

export type Action =
  | { readonly _tag: "Insert"; readonly text: string }
  | { readonly _tag: "Paste"; readonly text: string }
  | { readonly _tag: "Backspace" }
  | { readonly _tag: "DeleteForward" }
  | { readonly _tag: "DeleteWordBackward" }
  | { readonly _tag: "DeleteWordForward" }
  | { readonly _tag: "DeleteToLineStart" }
  | { readonly _tag: "DeleteToLineEnd" }
  | { readonly _tag: "Submit" }
  | { readonly _tag: "Newline" }
  | { readonly _tag: "CursorLeft" }
  | { readonly _tag: "CursorRight" }
  | { readonly _tag: "CursorHome" }
  | { readonly _tag: "CursorEnd" }
  | { readonly _tag: "WordLeft" }
  | { readonly _tag: "WordRight" }
  | { readonly _tag: "FocusPrev" }
  | { readonly _tag: "FocusNext" }
  | { readonly _tag: "OpenPalette" }
  | { readonly _tag: "ClosePalette" }
  | { readonly _tag: "PaletteUp" }
  | { readonly _tag: "PaletteDown" }
  | { readonly _tag: "PaletteRun" }
  | { readonly _tag: "PaletteInsert"; readonly text: string }
  | { readonly _tag: "PaletteBackspace" }
  | { readonly _tag: "OpenShortcuts" }
  | { readonly _tag: "CloseOverlay" }
  | { readonly _tag: "OpenModePicker" }
  | { readonly _tag: "ModePickerNext" }
  | { readonly _tag: "ModePickerPrev" }
  | { readonly _tag: "ModePickerClose" }
  | { readonly _tag: "ToggleDetails" }
  | { readonly _tag: "CycleReasoning" }
  | { readonly _tag: "ToggleFastMode" }
  | { readonly _tag: "ToggleRemoteArm" }
  | { readonly _tag: "OpenEditor" }
  | { readonly _tag: "PasteImage" }
  | { readonly _tag: "ForceInterrupt" }
  | { readonly _tag: "Steer" }
  | { readonly _tag: "Quit" }
  | { readonly _tag: "ArchiveNew" }
  | { readonly _tag: "ArchiveQuit" }
  | { readonly _tag: "FileMention" }
  | { readonly _tag: "DequeueSelected" }
  | { readonly _tag: "HistoryPrev" }
  | { readonly _tag: "NavPrevMessage" }
  | { readonly _tag: "NavNextMessage" }
  | { readonly _tag: "EditMessage" }

export type Pending = string

export type Resolution =
  | { readonly _tag: "Action"; readonly action: Action }
  | { readonly _tag: "Pending"; readonly chord: Pending }
  | { readonly _tag: "Ignore" }

export interface SettingsInput {
  readonly entries: Readonly<Record<string, string | null>>
  readonly sources: Readonly<Record<string, OverrideSource>>
}

export interface KeymapWarning {
  readonly action_id: string
  readonly source: OverrideSource
  readonly message: string
}

export interface KeymapEntry {
  readonly id: string
  readonly chord: string | null
  readonly description: string
  readonly source: BindingSource
}

export interface EffectiveKeymap {
  readonly entries: ReadonlyArray<KeymapEntry>
  readonly warnings: ReadonlyArray<KeymapWarning>
  readonly bindings: ReadonlyArray<ResolvedBinding>
  readonly leader: KeyPattern
}

interface BindingDefinition {
  readonly id: string
  readonly defaultChord: string
  readonly description: string
  readonly surfaces: ReadonlyArray<Surface>
  readonly action: Action
  readonly when?: (context: Context) => boolean
}

interface ResolvedBinding {
  readonly id: string
  readonly keys: ReadonlyArray<KeyPattern>
  readonly action: Action
  readonly surfaces: ReadonlyArray<Surface>
  readonly when?: (context: Context) => boolean
}

class KeyPattern extends Data.Class<{
  readonly name: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly meta: boolean
  readonly shift: boolean
}> {}

type ParsedChord = Result.Result<{ readonly keys: ReadonlyArray<KeyPattern>; readonly chord: string }, string>
type ParsedToken = Result.Result<{ readonly pattern: KeyPattern; readonly label: string }, string>

const action = (value: Action): Resolution => ({ _tag: "Action", action: value })
const pending = (chord: Pending): Resolution => ({ _tag: "Pending", chord })
const ignore: Resolution = { _tag: "Ignore" }

const leaderId = "leader"
const defaultLeaderChord = "ctrl+x"
const keyPattern = (input: {
  readonly name: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly meta: boolean
  readonly shift: boolean
}) => new KeyPattern(input)

const defaultLeaderPattern = keyPattern({ name: "x", ctrl: true, alt: false, meta: false, shift: false })

const actionDefinitions: ReadonlyArray<BindingDefinition> = [
  {
    id: "app.quit",
    defaultChord: "ctrl+c ctrl+c",
    description: "Quit Rika",
    surfaces: ["input"],
    action: { _tag: "Quit" },
  },
  {
    id: "thread.new",
    defaultChord: "ctrl+c ctrl+n",
    description: "Archive the current thread and start a new one",
    surfaces: ["input"],
    action: { _tag: "ArchiveNew" },
  },
  {
    id: "thread.archiveAndQuit",
    defaultChord: "ctrl+c ctrl+e",
    description: "Archive the current thread and quit",
    surfaces: ["input"],
    action: { _tag: "ArchiveQuit" },
  },
  {
    id: "thread.newRemote",
    defaultChord: "<leader> r",
    description: "Toggle orb-backed thread creation",
    surfaces: ["input"],
    action: { _tag: "ToggleRemoteArm" },
  },
  {
    id: "palette.open",
    defaultChord: "ctrl+o",
    description: "Open the command palette",
    surfaces: ["input"],
    action: { _tag: "OpenPalette" },
  },
  {
    id: "palette.close",
    defaultChord: "ctrl+o",
    description: "Close the command palette",
    surfaces: ["palette"],
    action: { _tag: "ClosePalette" },
  },
  {
    id: "palette.close",
    defaultChord: "escape",
    description: "Close the command palette",
    surfaces: ["palette"],
    action: { _tag: "ClosePalette" },
  },
  {
    id: "palette.run",
    defaultChord: "enter",
    description: "Run the selected palette command",
    surfaces: ["palette"],
    action: { _tag: "PaletteRun" },
  },
  {
    id: "palette.up",
    defaultChord: "up",
    description: "Move command palette selection up",
    surfaces: ["palette"],
    action: { _tag: "PaletteUp" },
  },
  {
    id: "palette.down",
    defaultChord: "down",
    description: "Move command palette selection down",
    surfaces: ["palette"],
    action: { _tag: "PaletteDown" },
  },
  {
    id: "palette.backspace",
    defaultChord: "backspace",
    description: "Delete one character from the palette query",
    surfaces: ["palette"],
    action: { _tag: "PaletteBackspace" },
  },
  {
    id: "mode.next",
    defaultChord: "ctrl+s",
    description: "Open mode selection",
    surfaces: ["input"],
    action: { _tag: "OpenModePicker" },
  },
  {
    id: "modepicker.next",
    defaultChord: "ctrl+s",
    description: "Move mode selection forward",
    surfaces: ["modepicker"],
    action: { _tag: "ModePickerNext" },
  },
  {
    id: "modepicker.next",
    defaultChord: "down",
    description: "Move mode selection forward",
    surfaces: ["modepicker"],
    action: { _tag: "ModePickerNext" },
  },
  {
    id: "modepicker.previous",
    defaultChord: "up",
    description: "Move mode selection backward",
    surfaces: ["modepicker"],
    action: { _tag: "ModePickerPrev" },
  },
  {
    id: "modepicker.close",
    defaultChord: "escape",
    description: "Close mode selection",
    surfaces: ["modepicker"],
    action: { _tag: "ModePickerClose" },
  },
  {
    id: "modepicker.close",
    defaultChord: "enter",
    description: "Close mode selection",
    surfaces: ["modepicker"],
    action: { _tag: "ModePickerClose" },
  },
  {
    id: "thread.toggleDetails",
    defaultChord: "alt+t",
    description: "Expand or collapse tool and activity details",
    surfaces: ["input"],
    action: { _tag: "ToggleDetails" },
  },
  {
    id: "mode.reasoning.next",
    defaultChord: "alt+d",
    description: "Cycle reasoning effort",
    surfaces: ["input"],
    action: { _tag: "CycleReasoning" },
  },
  {
    id: "speed.toggleFast",
    defaultChord: "alt+r",
    description: "Toggle fast speed for this thread",
    surfaces: ["input"],
    action: { _tag: "ToggleFastMode" },
  },
  {
    id: "prompt.openEditor",
    defaultChord: "ctrl+g",
    description: "Edit the prompt in an external editor",
    surfaces: ["input"],
    action: { _tag: "OpenEditor" },
  },
  {
    id: "prompt.pasteImage",
    defaultChord: "ctrl+v",
    description: "Paste an image from the clipboard",
    surfaces: ["input"],
    action: { _tag: "PasteImage" },
  },
  {
    id: "prompt.history",
    defaultChord: "ctrl+r",
    description: "Restore a previous prompt",
    surfaces: ["input"],
    action: { _tag: "HistoryPrev" },
  },
  {
    id: "prompt.newline",
    defaultChord: "ctrl+j",
    description: "Insert a newline in the prompt",
    surfaces: ["input"],
    action: { _tag: "Newline" },
  },
  {
    id: "prompt.newline",
    defaultChord: "linefeed",
    description: "Insert a newline in the prompt",
    surfaces: ["input"],
    action: { _tag: "Newline" },
  },
  {
    id: "prompt.newline",
    defaultChord: "shift+enter",
    description: "Insert a newline in the prompt",
    surfaces: ["input"],
    action: { _tag: "Newline" },
  },
  {
    id: "prompt.newline",
    defaultChord: "enter",
    description: "Insert a newline in the prompt",
    surfaces: ["input"],
    action: { _tag: "Newline" },
    when: (context) => context.trailingBackslash,
  },
  {
    id: "prompt.steerQueuedMessage",
    defaultChord: "enter enter",
    description: "Steer with the next queued prompt",
    surfaces: ["input"],
    action: { _tag: "Steer" },
  },
  {
    id: "prompt.steerQueuedMessage",
    defaultChord: "enter",
    description: "Steer with the next queued prompt",
    surfaces: ["input"],
    action: { _tag: "Steer" },
    when: (context) => context.queueSelected,
  },
  {
    id: "prompt.submit",
    defaultChord: "enter",
    description: "Submit the prompt",
    surfaces: ["input"],
    action: { _tag: "Submit" },
    when: (context) => !context.queueSelected && !context.trailingBackslash,
  },
  {
    id: "prompt.dequeueSelected",
    defaultChord: "backspace",
    description: "Dequeue the selected prompt",
    surfaces: ["input"],
    action: { _tag: "DequeueSelected" },
    when: (context) => context.queueSelected,
  },
  {
    id: "prompt.backspace",
    defaultChord: "backspace",
    description: "Delete the character before the cursor",
    surfaces: ["input"],
    action: { _tag: "Backspace" },
  },
  {
    id: "prompt.deleteWordBackward",
    defaultChord: "ctrl+w",
    description: "Delete the word before the cursor",
    surfaces: ["input"],
    action: { _tag: "DeleteWordBackward" },
  },
  {
    id: "prompt.deleteWordBackward",
    defaultChord: "ctrl+backspace",
    description: "Delete the word before the cursor",
    surfaces: ["input"],
    action: { _tag: "DeleteWordBackward" },
  },
  {
    id: "prompt.deleteWordBackward",
    defaultChord: "alt+backspace",
    description: "Delete the word before the cursor",
    surfaces: ["input"],
    action: { _tag: "DeleteWordBackward" },
  },
  {
    id: "prompt.deleteForward",
    defaultChord: "ctrl+d",
    description: "Delete the character after the cursor",
    surfaces: ["input"],
    action: { _tag: "DeleteForward" },
  },
  {
    id: "prompt.deleteToLineStart",
    defaultChord: "ctrl+u",
    description: "Delete from cursor to line start",
    surfaces: ["input"],
    action: { _tag: "DeleteToLineStart" },
  },
  {
    id: "prompt.deleteToLineEnd",
    defaultChord: "ctrl+k",
    description: "Delete from cursor to line end",
    surfaces: ["input"],
    action: { _tag: "DeleteToLineEnd" },
  },
  {
    id: "prompt.deleteWordForward",
    defaultChord: "ctrl+delete",
    description: "Delete the word after the cursor",
    surfaces: ["input"],
    action: { _tag: "DeleteWordForward" },
  },
  {
    id: "prompt.deleteWordForward",
    defaultChord: "alt+delete",
    description: "Delete the word after the cursor",
    surfaces: ["input"],
    action: { _tag: "DeleteWordForward" },
  },
  {
    id: "prompt.wordLeft",
    defaultChord: "alt+b",
    description: "Move cursor one word left",
    surfaces: ["input"],
    action: { _tag: "WordLeft" },
  },
  {
    id: "prompt.wordLeft",
    defaultChord: "ctrl+left",
    description: "Move cursor one word left",
    surfaces: ["input"],
    action: { _tag: "WordLeft" },
  },
  {
    id: "prompt.wordLeft",
    defaultChord: "alt+left",
    description: "Move cursor one word left",
    surfaces: ["input"],
    action: { _tag: "WordLeft" },
  },
  {
    id: "prompt.wordRight",
    defaultChord: "alt+f",
    description: "Move cursor one word right",
    surfaces: ["input"],
    action: { _tag: "WordRight" },
  },
  {
    id: "prompt.wordRight",
    defaultChord: "ctrl+right",
    description: "Move cursor one word right",
    surfaces: ["input"],
    action: { _tag: "WordRight" },
  },
  {
    id: "prompt.wordRight",
    defaultChord: "alt+right",
    description: "Move cursor one word right",
    surfaces: ["input"],
    action: { _tag: "WordRight" },
  },
  {
    id: "prompt.cursorLeft",
    defaultChord: "left",
    description: "Move cursor left",
    surfaces: ["input"],
    action: { _tag: "CursorLeft" },
  },
  {
    id: "prompt.cursorRight",
    defaultChord: "right",
    description: "Move cursor right",
    surfaces: ["input"],
    action: { _tag: "CursorRight" },
  },
  {
    id: "prompt.cursorHome",
    defaultChord: "home",
    description: "Move cursor to line start",
    surfaces: ["input"],
    action: { _tag: "CursorHome" },
  },
  {
    id: "prompt.cursorEnd",
    defaultChord: "end",
    description: "Move cursor to line end",
    surfaces: ["input"],
    action: { _tag: "CursorEnd" },
  },
  {
    id: "focus.previous",
    defaultChord: "up",
    description: "Move focus up",
    surfaces: ["input"],
    action: { _tag: "FocusPrev" },
  },
  {
    id: "focus.next",
    defaultChord: "down",
    description: "Move focus down",
    surfaces: ["input"],
    action: { _tag: "FocusNext" },
  },
  {
    id: "message.navPrevious",
    defaultChord: "tab",
    description: "Navigate to the previous message",
    surfaces: ["input"],
    action: { _tag: "NavPrevMessage" },
  },
  {
    id: "message.navNext",
    defaultChord: "backtab",
    description: "Navigate to the next message",
    surfaces: ["input"],
    action: { _tag: "NavNextMessage" },
  },
  {
    id: "message.navNext",
    defaultChord: "shift+tab",
    description: "Navigate to the next message",
    surfaces: ["input"],
    action: { _tag: "NavNextMessage" },
  },
  {
    id: "message.edit",
    defaultChord: "e",
    description: "Edit the selected message",
    surfaces: ["input"],
    action: { _tag: "EditMessage" },
    when: (context) => context.navigating,
  },
  {
    id: "app.forceInterrupt",
    defaultChord: "escape escape",
    description: "Force interrupt the active turn",
    surfaces: ["input"],
    action: { _tag: "ForceInterrupt" },
  },
  {
    id: "shortcuts.open",
    defaultChord: "?",
    description: "Open keyboard shortcuts",
    surfaces: ["input"],
    action: { _tag: "OpenShortcuts" },
    when: (context) => context.inputEmpty,
  },
  {
    id: "file.mention",
    defaultChord: "@",
    description: "Mention a workspace file",
    surfaces: ["input"],
    action: { _tag: "FileMention" },
  },
]

const definitionIds = Array.from(new Set(actionDefinitions.map((definition) => definition.id)))
const actionDefinitionIds = new Set(definitionIds)
const definitionsById = new Map(
  definitionIds.map((id) => [id, actionDefinitions.filter((definition) => definition.id === id)] as const),
)

export const effectiveKeymap = (input: SettingsInput = { entries: {}, sources: {} }): EffectiveKeymap => {
  const warnings: Array<KeymapWarning> = []
  const leader = resolveLeader(input, warnings)
  const entries: Array<KeymapEntry> = [
    {
      id: leaderId,
      chord: leader.chord,
      description: "Leader key for leader shortcuts",
      source: leader.source,
    },
  ]
  const bindings: Array<ResolvedBinding> = []

  for (const id of definitionIds) {
    const definitions = definitionsById.get(id) ?? []
    const definition = definitions[0]
    if (definition === undefined) continue
    const override = input.entries[id]
    const source = input.sources[id] ?? "user"
    if (override === null) {
      entries.push({ id, chord: null, description: definition.description, source })
      continue
    }
    if (override !== undefined) {
      const parsed = parseChord(override, leader.pattern)
      const applied = Result.match(parsed, {
        onSuccess: ({ chord, keys }) => {
          entries.push({ id, chord, description: definition.description, source })
          bindings.push({ ...definition, keys })
          return true
        },
        onFailure: (message) => {
          warnings.push({ action_id: id, source, message })
          return false
        },
      })
      if (applied) continue
    }

    const parsedDefault = parseChord(definition.defaultChord, leader.pattern)
    if (Result.isSuccess(parsedDefault)) {
      entries.push({
        id,
        chord: parsedDefault.success.chord,
        description: definition.description,
        source: "default",
      })
      for (const defaultDefinition of definitions) {
        const parsedDefaultBinding = parseChord(defaultDefinition.defaultChord, leader.pattern)
        if (Result.isSuccess(parsedDefaultBinding)) {
          bindings.push({ ...defaultDefinition, keys: parsedDefaultBinding.success.keys })
        }
      }
    }
  }

  for (const id of Object.keys(input.entries)) {
    if (id !== leaderId && !actionDefinitionIds.has(id)) {
      warnings.push({
        action_id: id,
        source: input.sources[id] ?? "user",
        message: `Unknown keymap action ${id}.`,
      })
    }
  }

  return { entries, warnings, bindings, leader: leader.pattern }
}

export const warningLine = (warnings: ReadonlyArray<KeymapWarning>): string | undefined => {
  if (warnings.length === 0) return undefined
  const first = warnings[0]
  if (first === undefined) return undefined
  const rest = warnings.slice(1)
  const suffix = rest.length === 0 ? "" : `; ${rest.length} more`
  return `Keymap warning: ${first.action_id} (${first.source}) ${first.message}${suffix}`
}

export const resolve = (
  context: Context,
  current: Pending | undefined,
  key: Keys.Key,
  keymap: EffectiveKeymap = defaultEffectiveKeymap,
): Resolution => {
  if (current !== undefined) {
    const completion = resolveConfigured(context, current, key, keymap)
    if (completion !== undefined) return completion
  }

  const configured = resolveConfigured(context, undefined, key, keymap)
  if (configured !== undefined) return configured

  switch (context.surface) {
    case "palette":
      return resolvePalette(key)
    case "modepicker":
      return resolveModePicker(key)
    case "overlay":
      return resolveOverlay(key)
    default:
      return resolveInput(context, key)
  }
}

const resolvePalette = (key: Keys.Key): Resolution => {
  if (Keys.isPrintable(key)) return action({ _tag: "PaletteInsert", text: Keys.char(key) })
  return ignore
}

const resolveModePicker = (_key: Keys.Key): Resolution => ignore

const resolveOverlay = (_key: Keys.Key): Resolution => action({ _tag: "CloseOverlay" })

const resolveInput = (context: Context, key: Keys.Key): Resolution => {
  if (key.name === "paste" && key.sequence.length > 0) return action({ _tag: "Paste", text: key.sequence })

  if (Keys.isPrintable(key)) return action({ _tag: "Insert", text: Keys.char(key) })
  return ignore
}

const resolveConfigured = (
  context: Context,
  current: Pending | undefined,
  key: Keys.Key,
  keymap: EffectiveKeymap,
): Resolution | undefined => {
  const prefix = current === undefined ? [] : pendingPatterns(current, keymap)
  if (current !== undefined && prefix.length === 0) return undefined
  const sequence = [...prefix, patternFromKey(key)]
  const matches = keymap.bindings.filter(
    (binding) =>
      binding.surfaces.includes(context.surface) &&
      (binding.when === undefined || binding.when(context)) &&
      isPrefix(sequence, binding.keys),
  )
  const exact = matches.find((binding) => binding.keys.length === sequence.length)
  if (exact !== undefined) return action(exact.action)
  if (matches.length > 0) return pending(pendingLabel(sequence, keymap))
  return undefined
}

const resolveLeader = (
  input: SettingsInput,
  warnings: Array<KeymapWarning>,
): { readonly pattern: KeyPattern; readonly chord: string; readonly source: BindingSource } => {
  const override = input.entries[leaderId]
  if (override === undefined) return { pattern: defaultLeaderPattern, chord: defaultLeaderChord, source: "default" }
  const source = input.sources[leaderId] ?? "user"
  if (override === null || containsLeaderToken(override)) {
    warnings.push({ action_id: leaderId, source, message: "Leader must be a single non-leader chord." })
    return { pattern: defaultLeaderPattern, chord: defaultLeaderChord, source: "default" }
  }
  const parsed = parseChord(override, defaultLeaderPattern)
  if (Result.isFailure(parsed) || parsed.success.keys.length !== 1) {
    warnings.push({ action_id: leaderId, source, message: "Leader must be a single non-leader chord." })
    return { pattern: defaultLeaderPattern, chord: defaultLeaderChord, source: "default" }
  }
  const [pattern] = parsed.success.keys
  return pattern === undefined
    ? { pattern: defaultLeaderPattern, chord: defaultLeaderChord, source: "default" }
    : { pattern, chord: parsed.success.chord, source }
}

const parseChord = (chord: string, leader: KeyPattern): ParsedChord => {
  const tokens = chordTokens(chord)
  if (tokens.length === 0) return Result.fail("Chord must contain at least one key.")
  const parsed = tokens.map((token) => parseToken(token, leader))
  const invalid = parsed.find(Result.isFailure)
  if (invalid !== undefined) return Result.fail(invalid.failure)
  const valid = parsed.filter(Result.isSuccess).map((token) => token.success)
  return Result.succeed({
    keys: valid.map((token) => token.pattern),
    chord: valid.map((token) => token.label).join(" "),
  })
}

const chordTokens = (chord: string): ReadonlyArray<string> => {
  const trimmed = chord.trim().toLowerCase()
  if (trimmed.length === 0) return []
  return trimmed.replace(/<leader>(?=\S)/g, "<leader> ").split(/\s+/)
}

const containsLeaderToken = (chord: string) => chordTokens(chord).includes("<leader>")

const parseToken = (token: string, leader: KeyPattern): ParsedToken => {
  if (token === "<leader>") return Result.succeed({ pattern: leader, label: "<leader>" })
  const parts = token.split("+")
  if (parts.some((part) => part.length === 0)) return Result.fail(`Invalid chord token ${token}.`)
  const key = parts.at(-1)
  if (key === undefined) return Result.fail(`Invalid chord token ${token}.`)
  const modifiers = parts.slice(0, -1)
  let ctrl = false
  let alt = false
  let meta = false
  let shift = false
  for (const modifier of modifiers) {
    if (modifier === "ctrl" || modifier === "control") ctrl = true
    else if (modifier === "alt" || modifier === "option") alt = true
    else if (
      modifier === "meta" ||
      modifier === "cmd" ||
      modifier === "command" ||
      modifier === "super" ||
      modifier === "mod"
    )
      meta = true
    else if (modifier === "shift") shift = true
    else return Result.fail(`Unknown chord modifier ${modifier}.`)
  }
  const name = keyName(key)
  if (name === undefined) return Result.fail(`Unknown chord key ${key}.`)
  const pattern = keyPattern({ name, ctrl, alt, meta, shift })
  return Result.succeed({ pattern, label: formatPattern(pattern) })
}

const keyName = (key: string): string | undefined => {
  if (key === "enter") return "return"
  if (key === "esc") return "escape"
  if (key === "del") return "delete"
  if (knownKeyNames.has(key)) return key
  return key.length === 1 ? key : undefined
}

const knownKeyNames = new Set([
  "backspace",
  "backtab",
  "delete",
  "down",
  "end",
  "escape",
  "home",
  "left",
  "linefeed",
  "return",
  "right",
  "space",
  "tab",
  "up",
])

const patternFromKey = (key: Keys.Key): KeyPattern =>
  keyPattern({
    name: keyName(key.name.toLowerCase()) ?? key.name.toLowerCase(),
    ctrl: key.ctrl,
    alt: key.alt,
    meta: key.meta,
    shift: key.shift,
  })

const pendingPatterns = (current: Pending, keymap: EffectiveKeymap): ReadonlyArray<KeyPattern> => {
  if (current === "leader") return [keymap.leader]
  if (current === "ctrl-c") return [keyPattern({ name: "c", ctrl: true, alt: false, meta: false, shift: false })]
  if (current === "esc") return [keyPattern({ name: "escape", ctrl: false, alt: false, meta: false, shift: false })]
  if (current === "enter") return [keyPattern({ name: "return", ctrl: false, alt: false, meta: false, shift: false })]
  const parsed = parseChord(current, keymap.leader)
  return Result.match(parsed, { onSuccess: ({ keys }) => keys, onFailure: () => [] })
}

const isPrefix = (candidate: ReadonlyArray<KeyPattern>, full: ReadonlyArray<KeyPattern>) =>
  candidate.length <= full.length &&
  candidate.every((pattern, index) => {
    const expected = full[index]
    return expected !== undefined && patternEquals(pattern, expected)
  })

const patternEquals = (left: KeyPattern, right: KeyPattern) => Equal.equals(left, right)

const pendingLabel = (patterns: ReadonlyArray<KeyPattern>, keymap: EffectiveKeymap): Pending => {
  if (patterns.length === 1) {
    const pattern = patterns[0]
    if (pattern !== undefined && patternEquals(pattern, keymap.leader)) return "leader"
    if (
      pattern !== undefined &&
      patternEquals(pattern, keyPattern({ name: "c", ctrl: true, alt: false, meta: false, shift: false }))
    )
      return "ctrl-c"
    if (
      pattern !== undefined &&
      patternEquals(pattern, keyPattern({ name: "escape", ctrl: false, alt: false, meta: false, shift: false }))
    ) {
      return "esc"
    }
    if (
      pattern !== undefined &&
      patternEquals(pattern, keyPattern({ name: "return", ctrl: false, alt: false, meta: false, shift: false }))
    ) {
      return "enter"
    }
  }
  return patterns.map(formatPattern).join(" ")
}

const formatPattern = (pattern: KeyPattern) => {
  const modifiers = [
    ...(pattern.ctrl ? ["ctrl"] : []),
    ...(pattern.alt ? ["alt"] : []),
    ...(pattern.meta ? ["meta"] : []),
    ...(pattern.shift ? ["shift"] : []),
  ]
  const name = pattern.name === "return" ? "enter" : pattern.name
  return [...modifiers, name].join("+")
}

export const defaultEffectiveKeymap = effectiveKeymap()
