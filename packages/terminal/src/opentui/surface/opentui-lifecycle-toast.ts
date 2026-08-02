import { StyledText, fg, type ColorInput } from "@opentui/core"
import stringWidth from "string-width"
import { colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { truncateToWidth } from "../../presentation/terminal/terminal-format"
import { SurfaceLifecycleLayout } from "./opentui-lifecycle-layout"

export abstract class SurfaceLifecycleToast extends SurfaceLifecycleLayout {
  showToast(message: string, color: ColorInput = toOpenColor(colors.green)): void {
    const terminalWidth = Math.max(1, this.model?.width ?? this.renderer.width)
    const right = Math.min(2, Math.max(0, terminalWidth - 1))
    const width = Math.max(1, Math.min(stringWidth(message) + 6, terminalWidth - right))
    const visibleMessage = truncateToWidth(message, Math.max(0, width - 6))
    this.toast.content = new StyledText([fg(color)("✓ "), fg(toOpenColor(colors.text))(visibleMessage)])
    this.toastBox.borderColor = color
    this.toastBox.right = right
    this.toastBox.width = width
    this.toastBox.visible = true
    this.renderer.requestRender()
    this.cancelTimer(this.toastTimer)
    this.toastTimer = this.delayed(2500, () => {
      this.toastBox.visible = false
      this.toastTimer = undefined
      this.renderer.requestRender()
    })
  }
}
