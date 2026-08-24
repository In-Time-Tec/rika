import { Function } from "effect"
import { isReady } from "../loadable"

import type { Model } from "../model"

export const isNarrow = (model: Model): boolean => model.width < 60
export const threadSidebarWidth = 36
export const boundedThreadSidebarWidth = (terminalWidth: number): number =>
  Math.min(threadSidebarWidth, Math.max(8, terminalWidth - 24))
export const threadSidebarLayoutWidth = (model: Model): number =>
  model.threadSidebar.open ? boundedThreadSidebarWidth(model.width) : 0
export const fileSidebarLayoutWidth = (model: Model): number => {
  const visible =
    !isNarrow(model) &&
    ((model.changedFilesOpen && isReady(model.changedFiles)) ||
      (model.workspaceFilesOpen && isReady(model.filePicker.items)))
  return visible
    ? Math.max(
        0,
        Math.min(model.sidebarWidth, Math.floor(model.width * 0.4), model.width - threadSidebarLayoutWidth(model) - 4),
      )
    : 0
}
export const contentColumnWidth = (model: Model): number =>
  Math.max(1, model.width - fileSidebarLayoutWidth(model) - threadSidebarLayoutWidth(model))

export const composerHeightLimit = (terminalHeight: number): number =>
  Math.max(1, Math.min(5, terminalHeight), terminalHeight - 4)
const clampSidebarWidthImpl = (width: number, terminalWidth: number): number =>
  Math.max(24, Math.min(width, Math.max(24, Math.floor(terminalWidth * 0.4))))

export const clampSidebarWidth: {
  (
    arg1: Parameters<typeof clampSidebarWidthImpl>[1],
  ): (arg0: Parameters<typeof clampSidebarWidthImpl>[0]) => ReturnType<typeof clampSidebarWidthImpl>
  (
    arg0: Parameters<typeof clampSidebarWidthImpl>[0],
    arg1: Parameters<typeof clampSidebarWidthImpl>[1],
  ): ReturnType<typeof clampSidebarWidthImpl>
} = Function.dual(2, clampSidebarWidthImpl)
