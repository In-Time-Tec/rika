import { type MouseEvent, StyledText, dim, fg, type ColorInput } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import type { ChangedFileRow } from "./opentui-surface-transcript-types"
import { SidebarController } from "./opentui-sidebar-controller"
import { contentColumnWidth } from "../../state/model/terminal-layout-state"
import { spacing, colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { formatActivity } from "../../state/model/terminal-activity-state"
import { loaderFrame, spinnerFrames, spinnerInterval } from "../rendering/opentui-spinner"
import { renderSidebar } from "../rendering/opentui-render-block"
import { goalAnimationActive, goalIndicatorVisible, panelLoading, welcomeContent } from "./opentui-surface-content"
import { goalLabelContent } from "./opentui-goal-controller"
import { welcomeAnimationActive, welcomeAnimationSettled } from "./opentui-welcome-state"
import { ToastController } from "./opentui-toast-controller"
import { SurfaceOverlay } from "./opentui-surface-overlay"

export abstract class SurfaceChrome extends SurfaceOverlay {
  protected abstract renderModeLabel(model: Model): void
  protected sidebarController!: SidebarController
  protected initializeSidebar(): void {
    this.sidebarController = new SidebarController({
      renderer: this.renderer,
      box: this.changedFilesBox,
      text: this.changedFilesText,
      model: () => this.model,
      dragging: () => this.pointerController.sidebarDrag !== undefined,
      destroyed: () => this.destroyed,
      hoveredRow: () => this.changedFilesHoveredRow,
    })
  }
  protected refreshSidebarRows(model: Model): void {
    this.sidebarController.refreshRows(model)
  }
  protected refreshSidebarWindow(force = false): boolean {
    return this.sidebarController.refreshWindow(force)
  }
  protected refreshSidebarAfterLayout(): void {
    this.sidebarController.refreshAfterLayout()
  }
  public sidebarRows(): ReadonlyArray<ChangedFileRow> {
    return this.sidebarController.rows
  }
  protected welcomeWidthFor(model: Model): number {
    return Math.max(1, contentColumnWidth(model) - spacing.transcript * 2)
  }
  protected publishWorkingFrame(frame: string | undefined): void {
    if (this.loaderController.published && this.loaderController.publishedFrame === frame) return
    this.loaderController.published = true
    this.loaderController.publishedFrame = frame
    this.handlers.workingFrame?.(frame)
  }
  protected refreshUsageHoverAfterLayout(): void {
    this.hoverController.scheduleRefresh(() => {
      const hovered = this.hoverController.hoveredAt(this.modeLabel.screenX, this.hoverController.pointerX)
      if (!this.hoverController.applyHover(hovered)) return
      this.renderer.setMousePointer(hovered ? "pointer" : "default")
      if (this.model !== undefined) this.renderModeLabel(this.model)
      this.renderer.requestRender()
    })
  }
  protected tickWelcome(): void {
    if (this.destroyed || !this.welcomeController.running) return
    const current = this.model
    if (current === undefined || !welcomeAnimationActive(current) || this.welcomeController.child === undefined) return
    if (welcomeAnimationSettled(this.welcomeController.phase, this.welcomeController.impulses)) {
      this.welcomeController.stop()
      return
    }
    this.welcomeController.advance()
    const welcomeWidth = this.welcomeWidthFor(current)
    const impulses = this.welcomeController.impulses
    this.welcomeController.key = `${welcomeWidth}:${current.height}:${this.welcomeController.phase}:${current.mode}:${impulses.length}`
    this.welcomeController.child.content = welcomeContent(
      welcomeWidth,
      current.height,
      this.welcomeController.phase,
      current.mode,
      impulses,
    )
    this.renderer.requestRender()
  }
  protected strikeWelcomeOrb(event: MouseEvent): void {
    const current = this.model
    const child = this.welcomeController.child
    if (this.destroyed || current === undefined || child === undefined) return
    this.welcomeController.strike(this.welcomeWidthFor(current), current.height, event.x - child.x, event.y - child.y)
    if (this.options.animate !== false && welcomeAnimationActive(current))
      this.welcomeController.start(spinnerInterval, () => this.tickWelcome())
    this.renderer.requestRender()
  }
  protected tickGoal(): void {
    if (this.destroyed || !this.goalController.running) return
    const current = this.model
    if (current === undefined || !goalAnimationActive(current)) return
    this.goalController.advance()
    this.renderGoalLabel(current)
    this.renderer.requestRender()
  }
  protected renderGoalLabel(model: Model): void {
    this.goalLabel.content = goalIndicatorVisible(model)
      ? goalLabelContent(this.goalController.frame, this.currentTimeMillis() - model.goal!.startedAtMillis)
      : ""
  }
  protected tickLoader(): void {
    if (this.destroyed || !this.loaderController.running) return
    this.loaderController.advance()
    this.handlers.animationTick?.()
    this.toolSpinner.step()
    const current = this.model
    if (current !== undefined) {
      const label =
        current.connectionStatus ??
        formatActivity(
          current.activity,
          current.activity?._tag === "Retrying"
            ? Math.max(0, Math.ceil((current.activity.nextAt - this.currentTimeMillis()) / 1000))
            : undefined,
        ) ??
        panelLoading(current)
      if (label !== undefined) {
        this.statusLabel.content = new StyledText([
          fg(toOpenColor(colors.text))(" "),
          fg(toOpenColor(colors.blue))(loaderFrame(label, current.animationTick + this.loaderController.phase)),
          dim(fg(toOpenColor(colors.text))(` ${label} `)),
        ])
      }
      const glyph = this.toolSpinner.toBraille()
      if (current.busy) this.publishWorkingFrame(glyph)
      if (current.usageDisplay === "time" && current.usageTime?._tag === "Available") this.renderModeLabel(current)
      this.transcriptPane.updateSpinner(glyph)
      if (current.threadSidebar.open)
        this.sidebar.content = renderSidebar(
          current,
          spinnerFrames[this.loaderController.phase % spinnerFrames.length]!,
        )
    }
    this.renderer.requestRender()
  }
  protected toastController!: ToastController
  protected initializeToast(): void {
    this.toastController = new ToastController({
      renderer: this.renderer,
      box: this.toastBox,
      text: this.toast,
      width: () => Math.max(1, this.model?.width ?? this.renderer.width),
      cancelTimer: (timer) => this.cancelTimer(timer),
      delayed: (duration, action) => this.delayed(duration, action),
    })
  }
  showToast(message: string, color?: ColorInput): void {
    this.toastController.show(message, color)
  }
  showCtrlCMenu(visible: boolean): void {
    this.ctrlCMenuBox.visible = visible
    this.ctrlCMenuTitle.visible = visible && (this.model?.width ?? this.renderer.width) >= 19
    this.renderer.requestRender()
  }
}
