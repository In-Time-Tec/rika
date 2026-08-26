import { EditBufferRenderable, RGBA, type CliRenderer } from "@opentui/core"

export class ProjectedEditorRenderable extends EditBufferRenderable {
  sync(text: string, cursor: number): void {
    if (this.plainText !== text) this.setText(text)
    this.cursorOffset = Math.max(0, Math.min(text.length, cursor))
  }
}

export const cutoutBackground = (_renderer: CliRenderer): RGBA => RGBA.defaultBackground()
