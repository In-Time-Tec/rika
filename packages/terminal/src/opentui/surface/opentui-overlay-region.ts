import { CliRenderEvents } from "@opentui/core"
import stringWidth from "string-width"
import { filter } from "../../presentation/terminal/command-palette"
import { colors } from "../../presentation/terminal/terminal-theme"
import { contextDetails } from "../../presentation/terminal/terminal-context-details"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { filteredFiles } from "../../state/model/terminal-thread-navigation"
import { type Model } from "../../state/model/terminal-state"
import { paletteContent, modePickerContent } from "./opentui-composer-region"
import { filePickerContent, threadSwitcherContent, threadSwitcherListWidth } from "./opentui-overlay-content"
import type { ProjectedEditorRenderable } from "./opentui-surface-construction"
import { SurfaceSidebarRegion } from "./opentui-sidebar-region"

export abstract class SurfaceOverlayRegion extends SurfaceSidebarRegion {
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
      const boxHeight = Math.min(9, Math.max(1, composerTop))
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = contentLeft + Math.max(0, contentWidth - boxWidth)
      this.paletteBox.top = Math.max(0, composerTop - boxHeight)
      this.paletteBox.title = ""
      this.paletteBox.bottomTitle = " ←→ turn · esc"
      this.paletteBox.bottomTitleAlignment = "right"
      this.palette.content = modePickerContent(model, Math.max(1, boxWidth - 4))
      cursorEditor = undefined
    } else if (overlay === "context") {
      const boxWidth = Math.min(58, contentWidth)
      const boxHeight = Math.min(9, Math.max(1, composerTop))
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = contentLeft + Math.max(0, contentWidth - boxWidth)
      this.paletteBox.top = Math.max(0, composerTop - boxHeight)
      this.paletteBox.title = " Context & Usage "
      this.paletteBox.titleColor = toOpenColor(colors.teal)
      this.paletteBox.titleAlignment = "left"
      this.paletteBox.bottomTitle = " Ctrl+Y toggle · esc "
      this.paletteBox.bottomTitleAlignment = "right"
      this.palette.content = contextDetails(
        model,
        Math.max(1, boxWidth - 4),
        Math.max(1, boxHeight - 2),
        this.currentTimeMillis(),
      )
      cursorEditor = this.composerEditor
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
      this.paletteBox.bottomTitle = " Opt+W/Ctrl+T all workspaces · Esc close "
      this.paletteBox.bottomTitleAlignment = "right"
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
