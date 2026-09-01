import { TextRenderable } from "@opentui/core"
import type { Model } from "../../../state/model"
import { contentColumnWidth, fileSidebarLayoutWidth, threadSidebarLayoutWidth } from "../../../state/layout/model"
import { spacing, modeColor } from "../../../presentation/terminal/theme"
import { cutoutBackground } from "../renderables"
import { welcomeContent } from "../content"
import { welcomeVisible } from "../welcome/state"
import { composerHeight } from "../../../state/layout/composer"
import { SurfaceModeLabel } from "../mode-label"

export abstract class SurfaceTranscriptMount extends SurfaceModeLabel {
  protected renderTranscript(model: Model, preserveAnchor = false) {
    this.model = model
    this.queueHint.bg = cutoutBackground(this.renderer)
    this.modeLabel.bg = cutoutBackground(this.renderer)
    this.workspaceLabel.bg = cutoutBackground(this.renderer)
    this.statusLabel.bg = cutoutBackground(this.renderer)
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
    const activeModeColor = modeColor(model.mode)
    if (welcomeVisible(model)) {
      const welcomeWidth = this.welcomeWidthFor(model)
      const welcomePhase = this.options.animate === false ? model.animationTick : this.welcomeController.phase
      const impulses = this.welcomeController.impulses
      const welcomeKey = `${welcomeWidth}:${model.height}:${welcomePhase}:${model.mode}:${impulses.length}`
      const existingWelcome = this.welcomeController.child
      if (existingWelcome === undefined) {
        const child = new TextRenderable(this.renderer, {
          content: welcomeContent(welcomeWidth, model.height, welcomePhase, model.mode, impulses),
          fg: activeModeColor,
          wrapMode: "word",
          selectable: true,
        })
        child.onMouseDown = (event) => this.strikeWelcomeOrb(event)
        this.transcriptPane.show(child)
        this.welcomeController.child = child
        this.welcomeController.key = welcomeKey
      } else if (this.welcomeController.key !== welcomeKey) {
        this.welcomeController.key = welcomeKey
        existingWelcome.fg = activeModeColor
        existingWelcome.content = welcomeContent(welcomeWidth, model.height, welcomePhase, model.mode, impulses)
      }
    } else {
      const renderModel = sidebarWidth === 0 && !threadSidebarVisible ? model : { ...model, width: contentWidth }
      this.transcriptPane.update(renderModel, preserveAnchor, this.toolSpinner.toBraille())
    }
    return { sidebarWidth, contentLeft, contentWidth, renderedInputHeight, sidebarVisible, threadSidebarVisible }
  }
}
