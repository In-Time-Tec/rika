import { update, canSubmit } from "../../src/state/reducer/terminal-state-reducer"
import { idle, ready, readyOr } from "../../src/state/model/terminal-loadable-state"
import {
  streamActivity,
  runningToolsActivity,
  formatActivity,
  formatActivityCounter,
} from "../../src/state/model/terminal-activity-state"
import { activeTimeAt, formatActiveTime, activeTimeIcon } from "../../src/state/model/terminal-activity-time"
import { replaceQueue, resetQueue, applyQueueDelta } from "../../src/state/model/terminal-queue-state"
import { replaceTurnPrompt } from "../../src/state/model/terminal-queue-prompt"
import { classifyPrompt, promptParts, displayInput } from "../../src/state/model/terminal-composer-state"
import { expandPastedText, pastedTextTokenAt } from "../../src/state/model/terminal-composer-paste"
import { nextMode, nextUsageDisplay } from "../../src/state/model/terminal-mode-selection"
import { inputRows, composerHeight, wrappedRowCount } from "../../src/state/model/terminal-layout-composer"
import { isNarrow, contentColumnWidth, boundedThreadSidebarWidth } from "../../src/state/model/terminal-layout-state"
import {
  filteredFiles,
  filteredThreads,
  selectedThreadMetadata,
} from "../../src/state/model/terminal-thread-navigation"
import { fromOpenTui, isPrintable, type Key } from "../../src/presentation/terminal/terminal-keymap"
import { filter, commands } from "../../src/presentation/terminal/command-palette"
import { projectUnits, projectChildUnits } from "../../src/presentation/transcript/terminal-transcript-projection"
import { transcriptUnits, transcriptUnitId, expandableRowIds } from "../../src/presentation/transcript/transcript-row"
import {
  applyTurnUnits,
  applyTurnDelta,
  applyRootUnits,
  applyChildUnits,
} from "../../src/presentation/transcript/terminal-transcript-presentation"
import { attachChildProjections, emptyAttachments } from "../../src/presentation/transcript/transcript-attachment"
import {
  resolveRowEnd,
  shiftRowEnd,
  relocateRowEnd,
} from "../../src/presentation/transcript/terminal-transcript-window"
import { pinnedRowWindow } from "../../src/presentation/transcript/transcript-row-window-state"
import { includeRowEnd } from "../../src/presentation/transcript/transcript-row-window-include"
import { execute, type Adapter, type ModelTuning, type Action } from "../../src/terminal-session"
import {
  Mode,
  Entry,
  Model,
  initial,
  withModeRouteMap,
  type Mode as ModeType,
  type Entry as EntryType,
  type Model as ModelType,
} from "../../src/state/model/terminal-state"
import { ChangedFile, type ChangedFile as ChangedFileType } from "../../src/state/model/terminal-changed-file"
import { QueueItem, type QueueItem as QueueItemType } from "../../src/state/model/terminal-queue-item"
import type { ThreadItem } from "../../src/state/model/terminal-thread-state"
import type { TranscriptBlock, TranscriptItem } from "../../src/state/model/terminal-transcript-state"
import type { PromptPart } from "../../src/state/model/terminal-composer-state"

export const ViewState = {
  update,
  canSubmit,
  idle,
  ready,
  readyOr,
  streamActivity,
  runningToolsActivity,
  formatActivity,
  formatActivityCounter,
  activeTimeAt,
  formatActiveTime,
  activeTimeIcon,
  replaceQueue,
  resetQueue,
  applyQueueDelta,
  replaceTurnPrompt,
  nextMode,
  nextUsageDisplay,
  classifyPrompt,
  promptParts,
  displayInput,
  expandPastedText,
  pastedTextTokenAt,
  inputRows,
  composerHeight,
  isNarrow,
  wrappedRowCount,
  contentColumnWidth,
  filteredFiles,
  filteredThreads,
  selectedThreadMetadata,
  boundedThreadSidebarWidth,
  Mode,
  Entry,
  ChangedFile,
  QueueItem,
  Model,
  initial,
  withModeRouteMap,
}
export const Keys = { fromOpenTui, isPrintable }
export const Palette = { filter, commands }
export const TranscriptPresenter = {
  applyTurnUnits,
  applyTurnDelta,
  applyRootUnits,
  applyChildUnits,
  attachChildProjections,
  emptyAttachments,
  transcriptUnits,
  transcriptUnitId,
  expandableRowIds,
  pinnedRowWindow,
  resolveRowEnd,
  shiftRowEnd,
  relocateRowEnd,
  includeRowEnd,
  rows: transcriptUnits,
  unitId: transcriptUnitId,
}
export const ExecutionEvents = { projectUnits, projectChildUnits }
export const Session = { execute }
export type {
  Key,
  Adapter,
  ModelTuning,
  Action,
  ThreadItem,
  TranscriptBlock,
  TranscriptItem,
  PromptPart,
  ModeType as Mode,
  EntryType as Entry,
  ModelType as Model,
  ChangedFileType as ChangedFile,
  QueueItemType as QueueItem,
}
