import { TextRenderable } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import {
  contentColumnWidth,
  fileSidebarLayoutWidth,
  threadSidebarLayoutWidth,
} from "../../state/model/terminal-layout-state"
import { spacing, colors } from "../../presentation/terminal/terminal-theme"
import { cutoutBackground } from "./opentui-surface-renderables"
import { welcomeContent } from "./opentui-surface-content"
import { welcomeVisible } from "./opentui-welcome-state"
import { composerHeight } from "../../state/model/terminal-layout-composer"
import { SurfaceModeLabel } from "./opentui-surface-mode-label"

export abstract class SurfaceTranscriptMount extends SurfaceModeLabel {
  protected renderTranscript(
    model: Model,
    preserveAnchor = false,
  ): {
    readonly sidebarWidth: number
    readonly contentLeft: number
    readonly contentWidth: number
    readonly renderedInputHeight: number
    readonly sidebarVisible: boolean
    readonly threadSidebarVisible: boolean
  } {
    this.model = model
    this.queueHint.bg = cutoutBackground(this.renderer)
    this.modeLabel.bg = cutoutBackground(this.renderer)
    this.workspaceLabel.bg = cutoutBackground(this.renderer)
    this.statusLabel.bg = cutoutBackground(this.renderer)
    this.goalLabel.bg = cutoutBackground(this.renderer)
    if (model.shortcutsOpen) this.setComposerResizePointer(false)
    const inputHeight = composerHeight(model)
    let renderedInputHeight = inputHeight
    if (model.shortcutsOpen) renderedInputHeight = Math.min(Math.max(1, model.height - 4), spacing.inputHeight + 12)
    else if (model.queue.length > 0) renderedInputHeight = Math.min(inputHeight, Math.max(1, model.height - 2))
    this.inputBox.minHeight = Math.min(spacing.inputHeight, renderedInputHeight)
    const sidebarWidth = fileSidebarLayoutWidth(model)
    const sidebarVisible = sidebarWidth > 0
    const contentLeft = threadSidebarLayoutWidth(model)
    const threadSidebarVisible = contentLeft > 0
    const contentWidth = contentColumnWidth(model)
    const modeColor = colors[model.mode]
    if (welcomeVisible(model)) {
      const welcomeWidth = this.welcomeWidthFor(model)
      const welcomePhase = this.options.animate === false ? model.animationTick : this.welcomeController.phase
      const impulses = this.welcomeController.impulses
      const welcomeKey = `${welcomeWidth}:${model.height}:${welcomePhase}:${model.mode}:${impulses.length}`
      const existingWelcome = this.welcomeController.child
      if (existingWelcome === undefined) {
        const child = new TextRenderable(this.renderer, {
          content: welcomeContent(welcomeWidth, model.height, welcomePhase, model.mode, impulses),
          fg: modeColor,
          wrapMode: "word",
          selectable: true,
        })
        child.onMouseDown = (event) => this.strikeWelcomeOrb(event)
        this.transcriptPane.show(child)
        this.welcomeController.child = child
        this.welcomeController.key = welcomeKey
      } else if (this.welcomeController.key !== welcomeKey) {
        this.welcomeController.key = welcomeKey
        existingWelcome.fg = modeColor
        existingWelcome.content = welcomeContent(welcomeWidth, model.height, welcomePhase, model.mode, impulses)
      }
    } else {
      const renderModel = sidebarWidth === 0 && !threadSidebarVisible ? model : { ...model, width: contentWidth }
      this.transcriptPane.update(renderModel, preserveAnchor, this.toolSpinner.toBraille())
    }
    return { sidebarWidth, contentLeft, contentWidth, renderedInputHeight, sidebarVisible, threadSidebarVisible }
  }
}
