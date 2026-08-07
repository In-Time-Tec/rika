import { CliRenderEvents, type CliRenderer, type EditBufferRenderable } from "@opentui/core"

export type FocusableEditor = EditBufferRenderable & { sync(text: string, cursor: number): void }

export interface FocusHost {
  readonly renderer: CliRenderer
  readonly destroyed: () => boolean
}

export class FocusController {
  private editor: FocusableEditor | undefined
  private restoreFrame: (() => void) | undefined

  constructor(private readonly host: FocusHost) {}

  get focused(): FocusableEditor | undefined {
    return this.editor
  }

  focus(editor: FocusableEditor | undefined): void {
    if (editor === this.editor) return
    this.editor?.blur()
    this.editor = editor
    this.editor?.focus()
    if (this.editor !== undefined) this.editor.showCursor = true
  }

  restoreCursor(): void {
    if (this.editor === undefined || this.restoreFrame !== undefined) return
    const restore = () => {
      this.restoreFrame = undefined
      if (this.host.destroyed() || this.editor === undefined) return
      this.editor.focus()
      this.editor.showCursor = true
      this.host.renderer.requestRender()
    }
    this.restoreFrame = restore
    this.host.renderer.once(CliRenderEvents.FRAME, restore)
    this.host.renderer.requestRender()
  }

  release(): void {
    if (this.restoreFrame === undefined) return
    this.host.renderer.off(CliRenderEvents.FRAME, this.restoreFrame)
    this.restoreFrame = undefined
  }
}
