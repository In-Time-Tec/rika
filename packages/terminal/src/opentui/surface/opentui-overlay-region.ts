import { CliRenderEvents } from "@opentui/core"
import stringWidth from "string-width"
import { filter } from "../../presentation/terminal/command-palette"
import { colors } from "../../presentation/terminal/terminal-theme"
import { contextDetails } from "../../presentation/terminal/terminal-context-details"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { truncateToWidth } from "../../presentation/terminal/terminal-format"
import { filteredFiles } from "../../state/model/terminal-thread-navigation"
import { type Model } from "../../state/model/terminal-state"
import { paletteContent, modeLabelStarts, modePickerContent } from "./opentui-composer-region"
import { modeIds } from "@rika/configuration/behavior-mode"
import { filePickerContent, threadSwitcherContent, threadSwitcherListWidth } from "./opentui-overlay-content"
import type { ProjectedEditorRenderable } from "./opentui-surface-construction"
import { SurfaceSidebarRegion } from "./opentui-sidebar-region"

export abstract class SurfaceOverlayRegion extends SurfaceSidebarRegion {
  private overlayDivider(label: string, width: number): string {
    return `├─ ${label} ${"─".repeat(Math.max(0, width - label.length - 5))}┤`
  }

  private renderOverlayHints(
    labels: ReadonlyArray<string>,
    color: string,
    bounds: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  ): void {
    const hints = [this.overlayHintOne, this.overlayHintTwo]
    for (const hint of hints) hint.visible = false
    const widthOf = (label: string): number => stringWidth(label.replaceAll("↔", "x"))
    const available = Math.max(0, bounds.width - 4)
    const fitted: Array<string> = []
    let used = 0
    let truncated = false
    for (const label of labels) {
      const separator = fitted.length === 0 ? 0 : 2
      const remaining = available - used - separator
      if (remaining <= 0) break
      const width = widthOf(label)
      let value = label
      if (width > remaining) value = remaining === 1 ? "…" : `${truncateToWidth(label, remaining - 1)}…`
      fitted.push(value)
      used += separator + widthOf(value)
      if (width > remaining) {
        truncated = true
        break
      }
    }
    const boxRight = Math.min(this.renderer.terminalWidth - 1, bounds.left + bounds.width - 1)
    let cursor = truncated || fitted.length < labels.length ? boxRight : boxRight - 1
    for (let index = fitted.length - 1; index >= 0; index -= 1) {
      const label = fitted[index]!
      const hint = hints[fitted.length - 1 - index]
      if (hint === undefined) continue
      const width = widthOf(label)
      cursor -= width
      hint.content = label
      hint.width = width
      hint.left = cursor
      hint.top = bounds.top + bounds.height - 1
      hint.fg = toOpenColor(color)
      hint.bg = toOpenColor(colors.surface)
      hint.visible = true
      cursor -= 2
    }
  }

  protected syncOverlayEditor(text: string, cursor: number, top: number, height: number, width: number): void {
    this.overlayEditor.visible = true
    this.overlayEditor.top = top
    this.overlayEditor.width = Math.max(1, width)
    this.overlayEditor.height = Math.max(1, height)
    this.overlayEditor.sync(text, cursor)
  }

  protected focusEditor(editor: typeof this.focusedEditor): void {
    if (editor === this.focusedEditor) return
    this.focusedEditor?.blur()
    this.focusedEditor = editor
    this.focusedEditor?.focus()
    if (this.focusedEditor !== undefined) this.focusedEditor.showCursor = true
  }

  protected restoreFocusedCursor(): void {
    if (this.focusedEditor === undefined || this.cursorRestoreFrame !== undefined) return
    const restore = () => {
      this.cursorRestoreFrame = undefined
      if (this.destroyed || this.focusedEditor === undefined) return
      this.focusedEditor.focus()
      this.focusedEditor.showCursor = true
      this.renderer.requestRender()
    }
    this.cursorRestoreFrame = restore
    this.renderer.once(CliRenderEvents.FRAME, restore)
    this.renderer.requestRender()
  }
  protected updateOverlay(
    model: Model,
    contentLeft: number,
    contentWidth: number,
    renderedInputHeight: number,
    threadSidebarVisible: boolean,
  ): void {
    const composerTop = model.height - renderedInputHeight
    let overlay: "threads" | "files" | "modes" | "context" | "palette" | undefined
    if (model.threadSwitcher.open) overlay = "threads"
    else if (model.filePicker.open) overlay = "files"
    else if (model.modePicker.open) overlay = "modes"
    else if (model.contextDetailsOpen) overlay = "context"
    else if (model.palette.open || model.paletteOpen) overlay = "palette"
    this.paletteBox.visible = overlay !== undefined
    this.palette.visible = this.paletteBox.visible
    this.paletteBox.bottomTitle = ""
    this.contextDividerOne.visible = false
    this.contextDividerTwo.visible = false
    this.contextFooter.visible = false
    this.overlayHintOne.visible = false
    this.overlayHintTwo.visible = false
    this.modeLabel.visible = true
    this.paletteBox.overflow = "hidden"
    this.palette.onMouseMove = undefined
    this.palette.onMouseDown = undefined
    let cursorEditor: ProjectedEditorRenderable | undefined =
      model.shortcutsOpen || (threadSidebarVisible && model.threadSidebar.focused) ? undefined : this.composerEditor
    if (overlay === "palette") {
      const results = filter(model.palette.query)
      const boxWidth = Math.max(1, Math.min(80, model.width - 4))
      const boxHeight = Math.min(Math.max(1, composerTop), results.length + 5)
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = Math.max(0, Math.floor((model.width - boxWidth) / 2))
      this.paletteBox.top = Math.max(0, Math.floor((composerTop - boxHeight) / 2))
      this.paletteBox.title = " Command Palette "
      this.paletteBox.titleColor = toOpenColor(colors.amber)
      this.paletteBox.titleAlignment = "left"
      this.palette.content = paletteContent(model, results, Math.max(1, boxWidth - 4), Math.max(1, boxHeight - 2))
      this.syncOverlayEditor(`> ${model.palette.query}`, 2 + model.palette.query.length, 0, boxHeight - 2, boxWidth - 4)
      cursorEditor = this.overlayEditor
    } else if (overlay === "modes") {
      const boxWidth = Math.min(58, contentWidth)
      const boxHeight = Math.min(boxWidth - 4 < 40 ? 9 : 15, Math.max(1, composerTop))
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = contentLeft + Math.max(0, contentWidth - boxWidth)
      this.paletteBox.top = Math.max(0, composerTop - boxHeight)
      this.paletteBox.title = " Mode "
      const selectedMode = modeIds[model.modePicker.selected] ?? model.mode
      this.paletteBox.titleColor = toOpenColor(colors[selectedMode])
      this.paletteBox.titleAlignment = "left"
      this.renderOverlayHints([" ↔ turn ", " esc "], colors[selectedMode], {
        left: this.paletteBox.left,
        top: this.paletteBox.top,
        width: boxWidth,
        height: boxHeight,
      })
      const modeContentWidth = Math.max(1, boxWidth - 4)
      if (modeContentWidth >= 40 && model.height > 12) {
        this.paletteBox.overflow = "visible"
        this.contextDividerOne.content = this.overlayDivider("Route", boxWidth)
        this.contextDividerTwo.content = this.overlayDivider("About", boxWidth)
        this.contextDividerOne.width = boxWidth
        this.contextDividerTwo.width = boxWidth
        this.contextDividerOne.left = -1
        this.contextDividerTwo.left = -1
        this.contextDividerOne.top = 4
        this.contextDividerTwo.top = 9
        this.contextDividerOne.visible = true
        this.contextDividerTwo.visible = true
      }
      this.palette.content = modePickerContent(model, modeContentWidth)
      const hitMode = (event: { readonly x: number; readonly y: number }): number | undefined => {
        const compact = modeContentWidth < 40 || model.height <= 12
        const labelRow = this.palette.screenY + (compact ? 1 : 2)
        if (event.y !== labelRow) return undefined
        const starts = modeLabelStarts(modeContentWidth)
        const pointer = event.x - this.palette.screenX
        let column = 0
        for (const [index, mode] of modeIds.entries()) {
          column = Math.max(column, Math.min(modeContentWidth, starts[index]!))
          const visible = truncateToWidth(mode, Math.max(0, modeContentWidth - column))
          const width = stringWidth(visible)
          if (pointer >= column && pointer < column + width) return index
          column += width
        }
        return undefined
      }
      this.palette.onMouseMove = (event) => {
        const selected = hitMode(event)
        this.renderer.setMousePointer(selected === undefined ? "default" : "pointer")
        if (selected !== undefined) this.handlers.modeHover?.(selected)
      }
      this.palette.onMouseDown = (event) => {
        if (event.button !== 0) return
        const selected = hitMode(event)
        if (selected !== undefined) this.handlers.modeCommit?.(selected)
      }
      cursorEditor = undefined
    } else if (overlay === "context") {
      const boxWidth = Math.min(68, contentWidth)
      const boxHeight = model.width <= 24 ? Math.min(12, model.height) : Math.min(18, Math.max(1, composerTop))
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = contentLeft + Math.max(0, contentWidth - boxWidth)
      this.paletteBox.top = Math.max(0, composerTop - boxHeight)
      this.paletteBox.title = " Context & Usage "
      this.paletteBox.titleColor = toOpenColor(colors[model.mode])
      this.paletteBox.titleAlignment = "left"
      this.renderOverlayHints([" Ctrl+Y toggle ", " esc "], colors[model.mode], {
        left: this.paletteBox.left,
        top: this.paletteBox.top,
        width: boxWidth,
        height: boxHeight,
      })
      if (model.width <= 24) {
        this.modeLabel.visible = false
        this.paletteBox.overflow = "visible"
        this.contextDividerOne.content = this.overlayDivider("Window", boxWidth)
        this.contextDividerTwo.content = this.overlayDivider("Session", boxWidth)
        this.contextDividerOne.width = boxWidth
        this.contextDividerTwo.width = boxWidth
        this.contextDividerOne.left = -1
        this.contextDividerTwo.left = -1
        this.contextDividerOne.top = 3
        this.contextDividerTwo.top = 6
        this.contextDividerOne.visible = true
        this.contextDividerTwo.visible = true
      } else if (boxHeight >= 18) {
        this.paletteBox.overflow = "visible"
        this.contextDividerOne.content = this.overlayDivider("Window", boxWidth)
        this.contextDividerTwo.content = this.overlayDivider("Session", boxWidth)
        this.contextDividerOne.width = boxWidth
        this.contextDividerTwo.width = boxWidth
        this.contextDividerOne.left = -1
        this.contextDividerTwo.left = -1
        this.contextDividerOne.top = 6
        this.contextDividerTwo.top = 11
        this.contextDividerOne.visible = true
        this.contextDividerTwo.visible = true
      }
      this.palette.content = contextDetails(
        model,
        Math.max(1, boxWidth - 4),
        Math.max(1, boxHeight - 2),
        this.currentTimeMillis(),
      )
      cursorEditor = undefined
    } else if (overlay === "files") {
      const entries = filteredFiles(model).map((file) => `@${file}`)
      const maxRows = Math.max(1, Math.min(20, composerTop - 1))
      const visibleEntries = entries.slice(0, Math.max(1, maxRows))
      const innerWidth = Math.max(...visibleEntries.map((entry) => stringWidth(entry)), 19)
      const availableWidth = contentWidth > 4 ? contentWidth - 4 : contentWidth
      const boxWidth = Math.max(1, Math.min(innerWidth + 4, availableWidth))
      const boxHeight = Math.min(Math.max(1, composerTop), Math.max(3, visibleEntries.length + 2))
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = contentLeft + Math.min(2, Math.max(0, contentWidth - boxWidth))
      this.paletteBox.top = Math.max(0, composerTop - boxHeight)
      this.paletteBox.title = ""
      this.palette.content = filePickerContent(model, visibleEntries, Math.max(1, boxWidth - 4))
    } else if (overlay === "threads") {
      const overlayWidth = Math.max(1, Math.min(140, model.width - 4))
      const overlayHeight = Math.min(Math.max(1, composerTop), Math.max(6, composerTop - 2))
      this.paletteBox.width = overlayWidth
      this.paletteBox.height = overlayHeight
      this.paletteBox.left = Math.max(0, Math.floor((model.width - overlayWidth) / 2))
      this.paletteBox.top = Math.max(0, composerTop - overlayHeight)
      this.paletteBox.title = model.threadSwitcher.kind === "mention" ? " Mention Thread " : " Switch Thread "
      this.paletteBox.titleAlignment = "left"
      this.renderOverlayHints([" Opt+W/Ctrl+T all workspaces ", " Esc close "], colors[model.mode], {
        left: this.paletteBox.left,
        top: this.paletteBox.top,
        width: overlayWidth,
        height: overlayHeight,
      })
      const switcherContentWidth = Math.max(1, overlayWidth - 4)
      const contentHeight = Math.max(1, overlayHeight - 2)
      const minute = Math.floor(this.currentTimeMillis() / 60_000)
      const cached = this.threadSwitcherContentCache
      if (
        cached !== undefined &&
        cached.threads === model.threads &&
        cached.preview === model.threadPreview &&
        cached.query === model.threadSwitcher.query &&
        cached.selected === model.threadSwitcher.selected &&
        cached.previewScroll === model.threadSwitcher.previewScroll &&
        cached.workspace === model.workspace &&
        cached.mode === model.mode &&
        cached.width === switcherContentWidth &&
        cached.height === contentHeight &&
        cached.minute === minute
      )
        this.palette.content = cached.content
      else {
        const content = threadSwitcherContent(model, switcherContentWidth, contentHeight)
        this.threadSwitcherContentCache = {
          threads: model.threads,
          preview: model.threadPreview,
          query: model.threadSwitcher.query,
          selected: model.threadSwitcher.selected,
          previewScroll: model.threadSwitcher.previewScroll,
          workspace: model.workspace,
          mode: model.mode,
          width: switcherContentWidth,
          height: contentHeight,
          minute,
          content,
        }
        this.palette.content = content
      }
      this.syncOverlayEditor(
        `> ${model.threadSwitcher.query}`,
        2 + model.threadSwitcher.query.length,
        1,
        overlayHeight - 2,
        threadSwitcherListWidth(model, overlayWidth - 4),
      )
      cursorEditor = this.overlayEditor
    }
    this.focusEditor(cursorEditor)
    if (cursorEditor !== this.overlayEditor) this.overlayEditor.visible = false
    this.renderer.requestRender()
  }
}
