import { type MouseEvent, StyledText, dim, fg, type ColorInput } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import type { ChangedFileRow } from "./opentui-surface-transcript-types"
import { SidebarController } from "./opentui-sidebar-controller"
import { contentColumnWidth } from "../../state/model/terminal-layout-state"
import { spacing, colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { formatActivity } from "../../state/model/terminal-activity-state"
import { animationFrame, animationIntervalMillis } from "../rendering/opentui-animation-frame"
import { renderSidebar } from "../rendering/opentui-render-block"
import {
  animationActive,
  goalAnimationActive,
  goalIndicatorVisible,
  panelLoading,
  welcomeContent,
} from "./opentui-surface-content"
import { goalLabelContent } from "./opentui-goal-label"
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
    if (this.publishedAny && this.publishedFrame === frame) return
    this.publishedAny = true
    this.publishedFrame = frame
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
  protected welcomePhase(): number {
    return Math.floor(this.animation.elapsedMillis() / animationIntervalMillis)
  }
  protected renderWelcome(): void {
    const current = this.model
    if (this.destroyed || current === undefined || this.welcomeController.child === undefined) return
    if (!welcomeAnimationActive(current)) return
    const phase = this.welcomePhase()
    this.welcomeController.expire(phase)
    const welcomeWidth = this.welcomeWidthFor(current)
    const impulses = this.welcomeController.impulses
    const key = `${welcomeWidth}:${current.height}:${phase}:${current.mode}:${impulses.length}`
    if (this.welcomeController.key === key) return
    this.welcomeController.key = key
    this.welcomeController.child.content = welcomeContent(welcomeWidth, current.height, phase, current.mode, impulses)
  }
  protected strikeWelcomeOrb(event: MouseEvent): void {
    const current = this.model
    const child = this.welcomeController.child
    if (this.destroyed || current === undefined || child === undefined) return
    this.welcomeController.strike(
      this.welcomeWidthFor(current),
      current.height,
      event.x - child.x,
      event.y - child.y,
      this.welcomePhase(),
    )
    if (this.options.animate !== false && welcomeAnimationActive(current)) this.animation.start()
    this.renderer.requestRender()
  }
  protected renderGoalLabel(model: Model): void {
    this.goalLabel.content = goalIndicatorVisible(model)
      ? goalLabelContent(
          animationFrame("goal", this.animation.elapsedMillis()),
          this.currentTimeMillis() - model.goal!.startedAtMillis,
        )
      : ""
  }
  protected renderStatusLabel(model: Model): void {
    const label =
      model.connectionStatus ??
      formatActivity(
        model.activity,
        model.activity?._tag === "Retrying"
          ? Math.max(0, Math.ceil((model.activity.nextAt - this.currentTimeMillis()) / 1000))
          : model.retryCountdown,
      ) ??
      panelLoading(model)
    if (label === undefined) {
      this.statusLabel.content = ""
      return
    }
    this.statusLabel.content = new StyledText([
      fg(toOpenColor(colors.text))(" "),
      fg(toOpenColor(colors.blue))(animationFrame("status", this.animation.elapsedMillis())),
      dim(fg(toOpenColor(colors.text))(` ${label} `)),
    ])
  }
  /** True while any element still has something to animate. */
  protected animationShouldRun(model: Model): boolean {
    if (this.options.animate === false) return false
    return (
      animationActive(model) ||
      goalAnimationActive(model) ||
      (welcomeAnimationActive(model) && !welcomeAnimationSettled(this.welcomePhase(), this.welcomeController.impulses))
    )
  }
  /**
   * The surface's single animation frame. Every animated element reads the same elapsed clock and
   * derives its own glyph from its own identity, so nothing is synchronised by construction.
   */
  protected onAnimationFrame(): boolean {
    if (this.destroyed) return false
    const elapsed = this.animation.elapsedMillis()
    const current = this.model
    if (current !== undefined) {
      if (animationActive(current)) this.handlers.animationTick?.()
      this.renderStatusLabel(current)
      if (goalAnimationActive(current)) this.renderGoalLabel(current)
      if (current.busy) this.publishWorkingFrame(animationFrame("working", elapsed))
      if (current.usageDisplay === "time" && current.usageTime?._tag === "Available") this.renderModeLabel(current)
      this.transcriptPane.updateAnimations(elapsed)
      this.renderWelcome()
      if (current.threadSidebar.open)
        this.sidebar.content = renderSidebar(current, animationFrame("thread-sidebar", elapsed))
    }
    this.renderer.requestRender()
    return current !== undefined && this.animationShouldRun(current)
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
  showQuitConfirmation(visible: boolean): void {
    this.quitConfirmationBox.visible = visible
    this.renderer.requestRender()
  }
}
