import stringWidth from "string-width"
import { StyledText, dim, fg } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import { colors, modeColor } from "../../presentation/terminal/terminal-theme"
import { filter } from "../../presentation/terminal/command-palette"
import { contextDetails } from "../../presentation/terminal/terminal-context-details"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { fitOverlayHints, overlayHintWidth } from "../../presentation/terminal/terminal-overlay-hints"
import { filteredFiles } from "../../state/model/terminal-thread-navigation"
import { paletteContent, modePickerContent } from "./opentui-composer-region"
import {
  modeSelectorIndexAtColumn,
  modeSelectorLabels,
} from "../../presentation/terminal/terminal-mode-selector-layout"
import { filePickerContent } from "./opentui-overlay-content"
import { type ProjectedEditorRenderable } from "./opentui-surface-renderables"
import { SurfacePointer } from "./opentui-surface-pointer"

export abstract class SurfaceOverlay extends SurfacePointer {
  private overlayDivider(label: string, width: number): StyledText {
    return new StyledText([
      fg(colors.text)("├─ "),
      dim(fg(colors.muted)(label)),
      fg(colors.text)(` ${"─".repeat(Math.max(0, width - label.length - 5))}┤`),
    ])
  }
  private renderOverlayHints(
    labels: ReadonlyArray<string>,
    color: string,
    bounds: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  ): void {
    const hints = [this.overlayHintOne, this.overlayHintTwo]
    for (const hint of hints) hint.visible = false
    const widthOf = overlayHintWidth
    const { labels: fitted, truncated } = fitOverlayHints(labels, Math.max(0, bounds.width - 4))
    const boxRight = Math.min(this.renderer.terminalWidth - 1, bounds.left + bounds.width - 1)
    let cursor = truncated ? boxRight : boxRight - 1
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
  protected focusEditor(editor: ProjectedEditorRenderable): void {
    editor.focusable = true
    editor.focus()
    this.composerEditor.focusable = editor === this.composerEditor
    this.overlayEditor.focusable = editor === this.overlayEditor
    editor.showCursor = true
  }
  protected updateOverlay(model: Model, contentLeft: number, contentWidth: number, renderedInputHeight: number): void {
    const composerTop = model.height - renderedInputHeight
    let overlay: "threads" | "files" | "modes" | "context" | "palette" | undefined
    if (model.threadSwitcher.open) overlay = "threads"
    else if (model.palette.open || model.paletteOpen) overlay = "palette"
    else if (model.filePicker.open) overlay = "files"
    else if (model.modePicker.open) overlay = "modes"
    else if (model.contextDetailsOpen) overlay = "context"
    this.paletteBox.visible = overlay !== undefined
    this.palette.visible = this.paletteBox.visible && overlay !== "threads"
    if (overlay !== "threads") this.threadBrowser.hide()
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
    let cursorEditor: ProjectedEditorRenderable = this.composerEditor
    if (overlay === "palette") {
      const results = filter(model.palette.query)
      const boxWidth = Math.max(1, Math.min(80, model.width - 4))
      const boxHeight = Math.min(Math.max(1, composerTop), model.palette.limit === undefined ? results.length + 5 : 6)
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = Math.max(0, Math.floor((model.width - boxWidth) / 2))
      this.paletteBox.top = Math.max(0, Math.floor((composerTop - boxHeight) / 2))
      if (model.palette.limit === "maxDepth") this.paletteBox.title = " Set Max Depth "
      else if (model.palette.limit === "maxSubagents") this.paletteBox.title = " Set Max Subagents "
      else this.paletteBox.title = " Command Palette "
      this.paletteBox.titleColor = toOpenColor(colors.amber)
      this.paletteBox.titleAlignment = "left"
      this.palette.content =
        model.palette.limit === undefined
          ? paletteContent(model, results, Math.max(1, boxWidth - 4), Math.max(1, boxHeight - 2))
          : `\n\nEnter an integer from 0 to 1024`
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
      const modes = Object.keys(model.modeRoutes)
      const selectedMode = modes[model.modePicker.selected] ?? model.mode
      this.paletteBox.titleColor = toOpenColor(modeColor(selectedMode))
      this.paletteBox.titleAlignment = "left"
      this.renderOverlayHints([" ↔ turn ", " esc "], modeColor(selectedMode), {
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
        return modeSelectorIndexAtColumn(modeSelectorLabels(modeContentWidth, modes), event.x - this.palette.screenX)
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
    } else if (overlay === "context") {
      const boxWidth = Math.min(68, contentWidth)
      const boxHeight = model.width <= 24 ? Math.min(12, model.height) : Math.min(18, Math.max(1, composerTop))
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = contentLeft + Math.max(0, contentWidth - boxWidth)
      this.paletteBox.top = Math.max(0, composerTop - boxHeight)
      this.paletteBox.title = " Context & Usage "
      this.paletteBox.titleColor = toOpenColor(modeColor(model.mode))
      this.paletteBox.titleAlignment = "left"
      this.renderOverlayHints([" Ctrl+Y toggle ", " esc "], modeColor(model.mode), {
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
      this.renderOverlayHints([" Opt+W/Ctrl+T all workspaces ", " Esc close "], modeColor(model.mode), {
        left: this.paletteBox.left,
        top: this.paletteBox.top,
        width: overlayWidth,
        height: overlayHeight,
      })
      const switcherContentWidth = Math.max(1, overlayWidth - 4)
      const contentHeight = Math.max(1, overlayHeight - 2)
      const browserLayout = this.threadBrowser.update(
        model,
        switcherContentWidth,
        contentHeight,
        this.currentTimeMillis(),
      )
      this.syncOverlayEditor(
        `> ${model.threadSwitcher.query}`,
        2 + model.threadSwitcher.query.length,
        1,
        1,
        browserLayout.listWidth,
      )
      cursorEditor = this.overlayEditor
    }
    this.focusEditor(cursorEditor)
    if (cursorEditor !== this.overlayEditor) this.overlayEditor.visible = false
    this.renderer.requestRender()
  }
}
