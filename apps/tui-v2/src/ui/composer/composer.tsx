import type { KeyEvent, PasteEvent, TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { Mode, ThreadView } from "../../client/model"
import { colors, modeColor } from "../theme"
import type { Drafts, FocusPanel } from "../types"

export interface ComposerProps {
  readonly thread: Accessor<ThreadView | undefined>
  readonly mode: Accessor<Mode>
  readonly focused: boolean
  readonly threadId: Accessor<string>
  readonly drafts: Accessor<Drafts>
  readonly updateDraft: (id: string, value: string) => void
  readonly setFocus: (focus: FocusPanel) => void
  readonly submit: (prompt: string) => void
  readonly interruptAndSend: (prompt: string) => void
  readonly editing: boolean
  readonly registerEditor?: (editor: TextareaRenderable | undefined) => void
  readonly handleKey?: (event: KeyEvent, editor: TextareaRenderable) => boolean
  readonly handlePaste?: (event: PasteEvent, editor: TextareaRenderable) => boolean
}

export function Composer(props: ComposerProps) {
  const dimensions = useTerminalDimensions()
  let editor: TextareaRenderable | undefined
  const submit = () => {
    const value = editor?.plainText ?? ""
    if (value.trim().length > 0 || props.editing) props.submit(value)
  }
  createEffect(() => {
    const next = props.drafts()[props.threadId()] ?? ""
    if (editor !== undefined && editor.plainText !== next) editor.setText(next)
  })
  onCleanup(() => props.registerEditor?.(undefined))
  const handleKey = (event: KeyEvent) => {
    if (editor !== undefined && props.handleKey?.(event, editor) === true) {
      event.preventDefault()
      return
    }
    if (event.ctrl && (event.name === "return" || event.name === "enter")) {
      event.preventDefault()
      const value = editor?.plainText ?? ""
      if (value.trim().length > 0) props.interruptAndSend(value)
    }
  }
  return (
    <box
      width="100%"
      height={5}
      minHeight={5}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={colors.text}
      backgroundColor={colors.surface}
      title={dimensions().width < 50 ? ` ${props.mode()} ` : ` ctx ᗧ······· 0% ─ ${props.mode()} `}
      titleColor={modeColor(props.mode())}
      titleAlignment="right"
      bottomTitle={dimensions().width < 60 ? "" : " /workspace "}
      bottomTitleAlignment="right"
      onMouseDown={() => props.setFocus("composer")}
      paddingLeft={1}
      paddingRight={1}
    >
      <textarea
        ref={(node) => {
          editor = node
          props.registerEditor?.(node)
        }}
        width="100%"
        height={3}
        wrapMode="word"
        focused={props.focused}
        textColor={colors.text}
        focusedTextColor={colors.text}
        backgroundColor={colors.surface}
        focusedBackgroundColor={colors.surface}
        cursorColor={modeColor(props.mode())}
        selectionBg={colors.selectionBg}
        selectionFg={colors.selectionFg}
        selectable
        keyBindings={[
          { name: "return", action: "submit" },
          { name: "return", shift: true, action: "newline" },
          { name: "linefeed", action: "newline" },
          { name: "j", ctrl: true, action: "newline" },
        ]}
        onKeyDown={handleKey}
        onPaste={(event) => {
          if (editor !== undefined && props.handlePaste?.(event, editor) === true) event.preventDefault()
        }}
        onContentChange={() => {
          if (editor !== undefined) props.updateDraft(props.threadId(), editor.plainText)
        }}
        onSubmit={submit}
      />
    </box>
  )
}
