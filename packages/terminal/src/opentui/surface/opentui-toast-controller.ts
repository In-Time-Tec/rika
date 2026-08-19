import { StyledText, fg, type ColorInput, type CliRenderer } from "@opentui/core"
import type { Fiber } from "effect"
import { colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { toastLayout } from "../../presentation/terminal/terminal-toast-layout"

export interface ToastBox {
  borderColor: ColorInput
  right: number | "auto" | `${number}%` | undefined
  width: number | "auto" | `${number}%` | undefined
  visible: boolean
}

export interface ToastText {
  content: StyledText
}

export interface ToastHost {
  readonly renderer: CliRenderer
  readonly box: ToastBox
  readonly text: ToastText
  readonly width: () => number
  readonly cancelTimer: (timer: Fiber.Fiber<void> | undefined) => void
  readonly delayed: (duration: number, action: () => void) => Fiber.Fiber<void>
}

export class ToastController {
  private timer: Fiber.Fiber<void> | undefined

  constructor(private readonly host: ToastHost) {}

  show(message: string, color: ColorInput = toOpenColor(colors.green)): void {
    const layout = toastLayout(message, this.host.width())
    this.host.text.content = new StyledText([fg(color)("✓ "), fg(toOpenColor(colors.text))(layout.message)])
    this.host.box.borderColor = color
    this.host.box.right = layout.right
    this.host.box.width = layout.width
    this.host.box.visible = true
    this.host.renderer.requestRender()
    this.host.cancelTimer(this.timer)
    this.timer = this.host.delayed(2500, () => {
      this.host.box.visible = false
      this.timer = undefined
      this.host.renderer.requestRender()
    })
  }

  release(): void {
    this.host.cancelTimer(this.timer)
    this.timer = undefined
  }
}
