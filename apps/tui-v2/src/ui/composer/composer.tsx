import type { KeyEvent, PasteEvent, TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, For, onCleanup, Show } from "solid-js"
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
  readonly help?: boolean
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
      height={props.help === true ? Math.min(17, dimensions().height) : 5}
      minHeight={props.help === true ? Math.min(17, dimensions().height) : 5}
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={colors.text}
      backgroundColor={colors.surface}
      title={dimensions().width < 50 ? ` ${props.mode()} ` : ` ctx ᗧ······· 0% ─ ${props.mode()} `}
      titleColor={modeColor(props.mode())}
      titleAlignment="right"
      onMouseDown={() => props.setFocus("composer")}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={props.help}>
        <scrollbox width="100%" flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column" }}>
          <For
            each={[
              ["Ctrl+O", "command palette", "Ctrl+R", "prompt history"],
              ["Ctrl+V", "paste images", "Shift+Enter", "newline"],
              ["Ctrl+S", "modes / steer", "Ctrl+Y", "context & usage"],
              ["Ctrl+G", "edit in $EDITOR", "Opt+T", "toggle file tree"],
              ["@ / @@", "mention files/threads", "Tab/Shift+Tab", "navigate messages"],
              ["D", "toggle details", "?", "toggle this help"],
            ]}
          >
            {(row) => (
              <box height={1} flexShrink={0} flexDirection="row">
                <text width={32} height={1} wrapMode="none">
                  <span style={{ fg: colors.blue }}>{row[0]}</span>
                  <span style={{ fg: colors.text }}>{` ${row[1]}`}</span>
                </text>
                <text flexGrow={1} height={1} wrapMode="none">
                  <span style={{ fg: colors.blue }}>{row[2]}</span>
                  <span style={{ fg: colors.text }}>{` ${row[3]}`}</span>
                </text>
              </box>
            )}
          </For>
          <text height={1} content="" />
          <text height={1} fg={colors.amber}>
            <b>Sidebar</b>
          </text>
          <text height={1}>
            <span style={{ fg: colors.blue }}>Opt+S</span>
            <span style={{ fg: colors.text }}> toggle changed files</span>
          </text>
          <text height={1}>
            <span style={{ fg: colors.blue }}>Enter</span>
            <span style={{ fg: colors.text }}> open selected thread</span>
          </text>
        </scrollbox>
        <box width="100%" height={1} flexShrink={0} border={["bottom"]} borderColor={colors.muted} />
      </Show>
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
        cursorColor={colors.text}
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
      <Show when={dimensions().width >= 60}>
        <text
          position="absolute"
          right={2}
          bottom={-1}
          height={1}
          fg={colors.muted}
          bg={colors.surface}
          content=" /workspace (main) "
        />
      </Show>
    </box>
  )
}
