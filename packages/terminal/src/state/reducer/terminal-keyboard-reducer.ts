import { Function } from "effect"
import { modeIds } from "@rika/configuration/behavior-mode"
import type { Message } from "../model/terminal-message"
import type {
  Model,
  TranscriptBlock,
  TranscriptItem,
  ThreadItem,
  QueueItem,
  ChangedFile,
} from "../model/terminal-state"
import { idle, loading, ready, readyOr } from "../model/terminal-loadable-state"
import { runningToolsActivity, streamActivity, type Activity } from "../model/terminal-activity-state"
import {
  classifyPrompt,
  expandPastedText,
  type ComposerAttachment,
  type PromptPart,
} from "../model/terminal-composer-state"
import {
  filteredFiles,
  filteredThreads,
  selectedThreadMetadata,
  renameThread,
} from "../model/terminal-thread-navigation"
import { composerHeight, clampSidebarWidth, wrappedRowCount, composerHeightLimit } from "../model/terminal-layout-state"
import {
  bindSubmittedDraft,
  dropSubmittedDrafts,
  settleSteering,
  takeSubmittedDraft,
  validQueueSelection,
} from "../model/terminal-queue-state"
import { filter, type PaletteAction } from "../../presentation/terminal/command-palette"
import { isPrintable, type Key } from "../../presentation/terminal/terminal-keymap"
import {
  expandableRowIds,
  rows as transcriptUnits,
  unitId as transcriptUnitId,
} from "../../presentation/transcript/terminal-transcript-presentation"
import {
  isDeliveredDelegationOutput,
  isFailedDelegationOutput,
  isSucceededDelegationOutput,
} from "../../presentation/transcript/transcript-row"
import { context } from "./terminal-state-reducer"
import { reduceKeyboardPrelude } from "./terminal-keyboard-prelude"
export const reduceKeyboard = (
  model: Model,
  message: Message,
  reduce: (model: Model, message: Message) => Model,
): Model | undefined => {
  const update = reduce
  const {
    sameChangedFiles,
    cancelTranscriptBlocks,
    insert,
    erase,
    lastCharacterLength,
    fileMention,
    questionKey,
    composerContext,
    continueShortcutsAfterEdit,
    insertWhileShortcutsOpen,
    pastedImagePath,
    pastedMention,
    insertPaste,
    insertImage,
    removeImage,
    expandPastedTextAttachment,
  } = context
  switch (message._tag) {
    case "KeyPressed": {
      const key = message.key
      const prelude = reduceKeyboardPrelude(model, key, update)
      if (prelude !== undefined) return prelude
      if (model.threadSwitcher.open) {
        const threads = filteredThreads(model)
        if (key.name === "escape")
          return {
            ...model,
            threadSwitcher: { open: false, query: "", selected: 0, kind: "switch", previewScroll: 0 },
            threadPreview: idle,
          }
        if (key.name === "return") {
          const thread = threads[model.threadSwitcher.selected]
          if (thread === undefined) return model
          if (model.threadSwitcher.kind === "mention") {
            return insert(
              erase(
                {
                  ...model,
                  threadSwitcher: {
                    open: false,
                    query: "",
                    selected: 0,
                    kind: "switch",
                    previewScroll: 0,
                  },
                  threadPreview: idle,
                },
                Math.min(2 + model.threadSwitcher.query.length, model.cursor),
              ),
              `@${thread.id} `,
            )
          }
          return {
            ...model,
            threadSwitcher: {
              open: false,
              query: "",
              selected: 0,
              kind: "switch",
              previewScroll: 0,
            },
            threadPreview: idle,
            pendingAction: thread.id === model.currentThreadId ? undefined : { _tag: "SelectThread", id: thread.id },
          }
        }
        if (key.name === "backspace") {
          if (model.threadSwitcher.kind === "mention" && model.threadSwitcher.query.length === 0)
            return erase(
              {
                ...model,
                threadSwitcher: {
                  open: false,
                  query: "",
                  selected: 0,
                  kind: "switch",
                  previewScroll: 0,
                },
                filePicker: { ...model.filePicker, open: true, query: "", selected: 0 },
              },
              1,
            )
          const next = {
            ...model,
            threadSwitcher: {
              ...model.threadSwitcher,
              query: model.threadSwitcher.query.slice(0, -lastCharacterLength(model.threadSwitcher.query)),
              selected: 0,
              previewScroll: 0,
            },
          }
          const restored =
            model.threadSwitcher.kind === "mention"
              ? erase(next, lastCharacterLength(model.threadSwitcher.query))
              : next
          return filteredThreads(restored).length === 0 ? { ...restored, threadPreview: idle } : restored
        }
        let selected = model.threadSwitcher.selected
        if (key.name === "up") {
          selected = (model.threadSwitcher.selected + Math.max(1, threads.length) - 1) % Math.max(1, threads.length)
        } else if (key.name === "down") {
          selected = (model.threadSwitcher.selected + 1) % Math.max(1, threads.length)
        }
        if (!isPrintable(key))
          return {
            ...model,
            threadSwitcher: {
              ...model.threadSwitcher,
              selected,
              previewScroll: selected === model.threadSwitcher.selected ? model.threadSwitcher.previewScroll : 0,
            },
          }
        const next = {
          ...model,
          threadSwitcher: {
            ...model.threadSwitcher,
            query: model.threadSwitcher.query + key.sequence,
            selected: 0,
            previewScroll: 0,
          },
        }
        const filtered = model.threadSwitcher.kind === "mention" ? insert(next, key.sequence) : next
        return filteredThreads(filtered).length === 0 ? { ...filtered, threadPreview: idle } : filtered
      }
      if (key.ctrl && key.name === "o") {
        const open = !model.palette.open
        return {
          ...model,
          paletteOpen: open,
          palette: { open, query: "", selected: 0 },
          modePicker: { ...model.modePicker, open: false },
          filePicker: { ...model.filePicker, open: false },
          shortcutsOpen: false,
        }
      }
      if (!model.filePicker.open && !key.ctrl && !key.alt && !key.meta && key.sequence === "@")
        return insert(
          {
            ...model,
            paletteOpen: false,
            palette: { open: false, query: "", selected: 0 },
            modePicker: { ...model.modePicker, open: false },
            filePicker: { ...model.filePicker, open: true, query: "", selected: 0 },
            shortcutsOpen: false,
          },
          "@",
        )
      if (key.ctrl && (key.name === "s" || key.name === "m") && !model.busy) {
        if (model.modePicker.open)
          return { ...model, modePicker: { open: true, selected: (model.modePicker.selected + 1) % 4 } }
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          modePicker: { open: true, selected: modeIds.indexOf(model.mode) },
          filePicker: { ...model.filePicker, open: false },
          shortcutsOpen: false,
        }
      }
      if (key.ctrl && key.name === "c" && !model.cancelPending && model.busy)
        return { ...model, activity: { _tag: "Waiting" }, cancelPending: model.busy, pendingAction: { _tag: "Cancel" } }
      if (key.ctrl && key.name === "s" && model.busy && !model.cancelPending && model.input.length > 0) {
        const steerText = expandPastedText(model.input, model.pastedText)
        return {
          ...model,
          pendingAction: {
            _tag: "Steer",
            prompt: steerText,
            ...(model.activeTurnId === undefined ? {} : { turnId: model.activeTurnId }),
          },
          ...(model.activeTurnId === undefined
            ? {}
            : { pendingSteering: [...model.pendingSteering, { turnId: model.activeTurnId, text: steerText }] }),
          input: "",
          cursor: 0,
        }
      }
      if (key.ctrl && key.name === "return" && model.busy && model.input.length > 0)
        return { ...model, pendingAction: { _tag: "InterruptAndSend", prompt: model.input }, input: "", cursor: 0 }
      if (key.alt && key.name === "t") {
        return update(model, { _tag: "WorkspaceFilesToggled" })
      }
      if (key.alt && key.name === "s") return update(model, { _tag: "SidebarViewToggled" })
      if (
        key.name === "escape" &&
        (model.palette.open || model.modePicker.open || model.filePicker.open || model.shortcutsOpen)
      )
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          modePicker: { ...model.modePicker, open: false },
          filePicker: { ...model.filePicker, open: false, query: "", selected: 0 },
          shortcutsOpen: false,
          shortcutsTrigger: undefined,
        }
      if (model.shortcutsOpen) {
        if (questionKey(key)) return { ...model, shortcutsOpen: false, shortcutsTrigger: undefined }
        if (isPrintable(key)) return insertWhileShortcutsOpen(model, key.sequence)
        const next = update(
          { ...model, shortcutsOpen: false, shortcutsTrigger: undefined },
          { _tag: "KeyPressed", key },
        )
        return continueShortcutsAfterEdit(model, next)
      }
      if (model.modePicker.open) {
        if (key.name === "escape") return { ...model, modePicker: { ...model.modePicker, open: false } }
        let selected = model.modePicker.selected
        if (key.name === "left" || key.name === "up") selected = (model.modePicker.selected + 3) % 4
        else if (key.name === "right" || key.name === "down") selected = (model.modePicker.selected + 1) % 4
        if (key.name === "return")
          return {
            ...model,
            mode: modeIds[selected]!,
            modePicker: { open: false, selected },
          }
        return { ...model, modePicker: { open: true, selected } }
      }
      if (model.palette.open) {
        const results = filter(model.palette.query)
        let selected = model.palette.selected
        if (key.name === "up") selected = Math.max(0, model.palette.selected - 1)
        else if (key.name === "down") {
          selected = Math.max(0, Math.min(results.length - 1, model.palette.selected + 1))
        }
        if (key.name === "return") {
          const action = results[selected]?.action as PaletteAction | undefined
          if (action === undefined) return { ...model, palette: { ...model.palette, selected: 0 } }
          if (action._tag === "OpenModePicker")
            return model.busy
              ? {
                  ...model,
                  paletteOpen: false,
                  palette: { open: false, query: "", selected: 0 },
                }
              : {
                  ...model,
                  paletteOpen: false,
                  palette: { open: false, query: "", selected: 0 },
                  modePicker: { open: true, selected: modeIds.indexOf(model.mode) },
                }
          if (action._tag === "SwitchThread")
            return {
              ...model,
              paletteOpen: false,
              palette: { open: false, query: "", selected: 0 },
              threadSwitcher: { open: true, query: "", selected: 0, kind: "switch", previewScroll: 0 },
            }
          if (action._tag === "ToggleFastMode")
            return {
              ...model,
              paletteOpen: false,
              palette: { open: false, query: "", selected: 0 },
              fastMode: !model.fastMode,
            }
          return {
            ...model,
            paletteOpen: false,
            palette: { open: false, query: "", selected: 0 },
            pendingAction: action,
          }
        }
        if (key.name === "backspace")
          return { ...model, palette: { ...model.palette, query: model.palette.query.slice(0, -1), selected: 0 } }
        return isPrintable(key)
          ? { ...model, palette: { ...model.palette, query: model.palette.query + key.sequence, selected: 0 } }
          : { ...model, palette: { ...model.palette, selected } }
      }
      if (model.filePicker.open) {
        const mentionLength = Math.min(1 + model.filePicker.query.length, model.cursor)
        if (isPrintable(key) && key.sequence === "@" && model.filePicker.query === "")
          return insert(
            {
              ...model,
              filePicker: { ...model.filePicker, open: false },
              threadSwitcher: { open: true, query: "", selected: 0, kind: "mention", previewScroll: 0 },
            },
            "@",
          )
        const files = filteredFiles(model)
        let selected = model.filePicker.selected
        if (key.name === "up") {
          selected = (model.filePicker.selected + Math.max(1, files.length) - 1) % Math.max(1, files.length)
        } else if (key.name === "down") {
          selected = (model.filePicker.selected + 1) % Math.max(1, files.length)
        }
        if (key.name === "return") {
          const file = files[selected]
          return file === undefined
            ? { ...model, filePicker: { ...model.filePicker, open: false } }
            : insert(
                erase(
                  { ...model, filePicker: { ...model.filePicker, open: false, query: "", selected: 0 } },
                  mentionLength,
                ),
                fileMention(file),
              )
        }
        if (key.name === "backspace") {
          if (model.filePicker.query.length > 0)
            return erase(
              {
                ...model,
                filePicker: {
                  ...model.filePicker,
                  query: model.filePicker.query.slice(0, -lastCharacterLength(model.filePicker.query)),
                  selected: 0,
                },
              },
              lastCharacterLength(model.filePicker.query),
            )
          return erase({ ...model, filePicker: { ...model.filePicker, open: false, selected: 0 } }, 1)
        }
        return isPrintable(key)
          ? insert(
              {
                ...model,
                filePicker: { ...model.filePicker, query: model.filePicker.query + key.sequence, selected: 0 },
              },
              key.sequence,
            )
          : { ...model, filePicker: { ...model.filePicker, selected } }
      }
      if (questionKey(key) && model.input.length === 0) {
        const trigger = model.cursor
        const next = insert(model, "?")
        return {
          ...next,
          shortcutsOpen: true,
          shortcutsTrigger: trigger,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          modePicker: { ...model.modePicker, open: false },
          filePicker: { ...model.filePicker, open: false },
        }
      }
      if ((key.name === "tab" || key.name === "backtab") && !key.ctrl && !key.alt && !key.meta)
        return update(model, { _tag: "DetailMoved", offset: key.name === "backtab" || key.shift ? -1 : 1 })
      if (
        key.name === "return" &&
        !key.ctrl &&
        !key.alt &&
        !key.meta &&
        !key.shift &&
        model.input.length === 0 &&
        model.detailSelection !== undefined
      )
        return update(model, { _tag: "DetailToggled" })
      const queued = model.queue as ReadonlyArray<QueueItem>
      if (model.busy && model.input.length === 0 && queued.length > 0 && model.editingTurnId === undefined) {
        const current = queued.findIndex((item) => item.id === model.queueSelection)
        if (current < 0) {
          if (key.name === "up")
            return {
              ...model,
              queueSelection: queued.at(-1)!.id,
            }
        } else {
          if (key.name === "escape") return { ...model, queueSelection: undefined }
          if (key.name === "up") {
            const index = Math.max(0, current - 1)
            return {
              ...model,
              queueSelection: queued[index]!.id,
            }
          }
          if (key.name === "down") {
            if (current === queued.length - 1) return { ...model, queueSelection: undefined }
            return {
              ...model,
              queueSelection: queued[current + 1]!.id,
            }
          }
          const selected = queued[current]!
          if (selected.provisional === true) return model
          if (key.ctrl && key.name === "e")
            return insert(
              {
                ...model,
                editingTurnId: selected.id,
                editReturn: { input: model.input, attachments: model.pastedText },
                input: "",
                cursor: 0,
                pastedText: [],
              },
              selected.prompt,
            )
          if (key.name === "return")
            return {
              ...model,
              ...(model.activeTurnId === undefined
                ? {}
                : {
                    pendingSteering: [...model.pendingSteering, { turnId: model.activeTurnId, text: selected.prompt }],
                  }),
              pendingAction: {
                _tag: "SteerQueued",
                id: selected.id,
                prompt: selected.prompt,
              },
            }
          if (key.name === "backspace") return { ...model, pendingAction: { _tag: "Dequeue", id: selected.id } }
        }
      }
      if ((key.name === "return" && key.shift) || key.name === "linefeed" || (key.ctrl && key.name === "j"))
        return insert(model, "\n")
      if (key.name === "return" && model.cursor > 0 && model.input[model.cursor - 1] === "\\") {
        const withoutSlash = {
          ...model,
          input: model.input.slice(0, model.cursor - 1) + model.input.slice(model.cursor),
          cursor: model.cursor - 1,
        }
        return insert(withoutSlash, "\n")
      }
      if (key.name === "up" || key.name === "down") {
        if (model.history.length === 0) return model
        const lineStart = model.input.lastIndexOf("\n", Math.max(0, model.cursor - 1)) + 1
        const lineEnd = model.input.indexOf("\n", model.cursor)
        if (key.name === "up" && lineStart > 0) return model
        if (key.name === "down" && lineEnd >= 0) return model
        const current = model.historyIndex ?? model.history.length
        const index = key.name === "up" ? Math.max(0, current - 1) : Math.min(model.history.length, current + 1)
        const savedDraft =
          model.historyIndex === undefined ? { input: model.input, attachments: model.pastedText } : model.historyDraft
        const draft = index === model.history.length ? savedDraft : model.historyComposers[index]
        const input = draft?.input ?? (index === model.history.length ? "" : model.history[index]!)
        return {
          ...model,
          historyIndex: index === model.history.length ? undefined : index,
          historyDraft: index === model.history.length ? undefined : savedDraft,
          input,
          pastedText: draft?.attachments ?? [],
          cursor: input.length,
        }
      }
      if (key.ctrl && key.name === "r") {
        const query = model.input || model.historySearch
        const input = model.history.toReversed().find((prompt) => prompt.includes(query)) ?? model.input
        return { ...model, input, cursor: input.length, historySearch: query }
      }
      if (((key.alt && key.name === "backspace") || (key.ctrl && key.name === "w")) && model.cursor > 0) {
        const before = model.input.slice(0, model.cursor)
        const trimmed = before.replace(/[ \t]+$/, "")
        const boundary = Math.max(trimmed.lastIndexOf(" "), trimmed.lastIndexOf("\n"), trimmed.lastIndexOf("\t"))
        const target = trimmed.length === 0 ? 0 : boundary + 1
        return { ...model, input: model.input.slice(0, target) + model.input.slice(model.cursor), cursor: target }
      }
      if (((key.meta && key.name === "backspace") || (key.ctrl && key.name === "u")) && model.cursor > 0) {
        const lineStart = model.input.lastIndexOf("\n", model.cursor - 1) + 1
        return {
          ...model,
          input: model.input.slice(0, lineStart) + model.input.slice(model.cursor),
          cursor: lineStart,
        }
      }
      if (key.name === "backspace" && model.cursor > 0) {
        return {
          ...model,
          input: model.input.slice(0, model.cursor - 1) + model.input.slice(model.cursor),
          cursor: model.cursor - 1,
        }
      }
      if (key.name === "left") return { ...model, cursor: Math.max(0, model.cursor - 1) }
      if (key.name === "right") return { ...model, cursor: Math.min(model.input.length, model.cursor + 1) }
      return isPrintable(key) ? insert(model, key.sequence) : model
    }
  }
  return undefined
}
