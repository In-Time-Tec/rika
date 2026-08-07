import { type ColorInput } from "@opentui/core"
import { SurfaceLifecycleLayout } from "./opentui-lifecycle-layout"
import { ToastController } from "./opentui-toast-controller"

export abstract class SurfaceLifecycleToast extends SurfaceLifecycleLayout {
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
}
