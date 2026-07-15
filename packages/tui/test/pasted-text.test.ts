import { describe, expect, it } from "@effect/vitest"
import { Session, ViewState } from "../src"

describe("pasted text attachments", () => {
  it("collapses multiline, carriage-return, and long paste while preserving short paste", () => {
    const values = ["first\nsecond", "first\rsecond", "x".repeat(121)]
    for (const value of values) {
      const model = ViewState.update(ViewState.initial("/work"), { _tag: "Pasted", text: value })
      expect(model.input).toHaveLength(1)
      expect(model.pastedText[0]?.type === "text" ? model.pastedText[0].value : undefined).toBe(value)
      expect(ViewState.displayInput(model)).toContain("[Pasted text #1")
    }
    const short = ViewState.update(ViewState.initial("/work"), { _tag: "Pasted", text: "short paste" })
    expect(short.input).toBe("short paste")
    expect(short.pastedText).toEqual([])
  })

  it("preserves surrounding typed text and pasted content through submission", () => {
    let model = { ...ViewState.initial("/work"), input: "before ", cursor: 7 }
    model = ViewState.update(model, { _tag: "Pasted", text: "line one\r\nline two" })
    model = ViewState.update(model, {
      _tag: "KeyPressed",
      key: { name: "x", sequence: " after", ctrl: false, alt: false, meta: false, shift: false, eventType: "press" },
    })
    const parts = ViewState.promptParts(model.input, model.pastedText)
    const submitted: Array<{ readonly prompt: string; readonly parts?: ReadonlyArray<ViewState.PromptPart> }> = []
    Session.execute(
      {
        submit: (prompt, promptParts) =>
          submitted.push(promptParts === undefined ? { prompt } : { prompt, parts: promptParts }),
        quit: () => undefined,
      },
      { _tag: "Submit", prompt: model.input, parts, mode: "ultra" },
    )
    expect(parts).toEqual([{ type: "text", text: "before line one\r\nline two after" }])
    expect(submitted).toEqual([{ prompt: model.input, parts }])
  })

  it("expands pasted text for editing and stores expanded transcript history", () => {
    const collapsed = ViewState.update(ViewState.initial("/work"), { _tag: "Pasted", text: "line one\nline two" })
    const attachment = collapsed.pastedText[0]!
    expect(ViewState.pastedTextTokenAt(collapsed, 2)).toBe(attachment.token)

    const expanded = ViewState.update(collapsed, { _tag: "PastedTextExpanded", token: attachment.token })
    expect(expanded.input).toBe("line one\nline two")
    expect(expanded.cursor).toBe(expanded.input.length)
    expect(expanded.pastedText).toEqual([])

    const submitted = ViewState.update(collapsed, { _tag: "Submitted" })
    expect(submitted.history.at(-1)).toBe("line one\nline two")
    const started = ViewState.update(submitted, { _tag: "TurnStarted", turnId: "turn-1", prompt: "line one\nline two" })
    expect(started.entries.at(-1)?.text).toBe("line one\nline two")
  })

  it("expands pasted attachment tokens before identifying image prompt parts", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "Pasted",
      text: "inspect [screen shot.png] and file:///tmp/other%20shot.webp",
    })
    model = ViewState.update(model, { _tag: "Pasted", text: "x".repeat(121) })

    expect(ViewState.displayInput(model)).toContain("[Pasted text #1]")
    expect(ViewState.promptParts(model.input, model.pastedText)).toEqual([
      { type: "text", text: "inspect " },
      { type: "image", path: "screen shot.png" },
      { type: "text", text: " and " },
      { type: "image", path: "/tmp/other shot.webp" },
      { type: "text", text: "x".repeat(121) },
    ])
  })

  it("keeps typed image attachments structured without reparsing their paths", () => {
    const token = String.fromCharCode(0xe000)
    expect(
      ViewState.promptParts(`before ${token} after`, [
        { type: "image", token, path: "odd [name].png", label: "[Image #1]" },
      ]),
    ).toEqual([
      { type: "text", text: "before " },
      { type: "image", path: "odd [name].png" },
      { type: "text", text: " after" },
    ])
  })

  it("removes only the failed image attachment while preserving later input", () => {
    let model = ViewState.update(ViewState.initial("/work"), { _tag: "ImageInserted", path: "failed.png" })
    model = ViewState.update(model, {
      _tag: "KeyPressed",
      key: { name: "x", sequence: "after", ctrl: false, alt: false, meta: false, shift: false, eventType: "press" },
    })
    model = ViewState.update(model, { _tag: "ImageRemoved", path: "failed.png" })
    expect(model.input).toBe("after")
    expect(model.cursor).toBe(5)
    expect(model.pastedText).toEqual([])
  })

  it("handles image-only, escaped, and malformed file image references", () => {
    expect(ViewState.promptParts("only\\ image.png")).toEqual([{ type: "image", path: "only image.png" }])
    expect(ViewState.promptParts("file:///tmp/bad%ZZ.png")).toEqual([{ type: "image", path: "file:///tmp/bad%ZZ.png" }])
  })

  it("inserts a terminal-pasted absolute image path containing spaces as one attachment", () => {
    const path = "/var/folders/example/T/Screen Shot 2026-07-12 at 10.00.00 PM.png"
    const model = ViewState.update(ViewState.initial("/work"), { _tag: "Pasted", text: `${path}\n` })
    expect(ViewState.displayInput(model)).toBe("[Image #1]")
    expect(ViewState.promptParts(model.input, model.pastedText)).toEqual([{ type: "image", path }])
  })

  it("keeps empty and incomplete shell submissions idle", () => {
    const empty = ViewState.initial("/work")
    expect(ViewState.update(empty, { _tag: "Submitted" })).toBe(empty)

    const shell = { ...empty, input: "$   ", cursor: 4 }
    expect(ViewState.update(shell, { _tag: "Submitted" })).toBe(shell)
  })

  it("applies explicit permission decisions only to the matching permission", () => {
    const permission = {
      _tag: "Permission" as const,
      id: "one",
      kind: "permission" as const,
      title: "Write",
      detail: "file",
      status: "pending" as const,
    }
    const notice = { _tag: "Notification" as const, title: "Notice", detail: "unchanged" }
    const model = { ...ViewState.initial("/work"), blocks: [permission, notice] }
    const updated = ViewState.update(model, { _tag: "PermissionDecisionSelected", id: "one", decision: "deny" })

    expect(updated.blocks).toEqual([{ ...permission, status: "denied" }, notice])
    expect(updated.pendingAction).toEqual({
      _tag: "DecidePermission",
      id: "one",
      kind: "permission",
      decision: "deny",
    })
  })

  it("opens the mode picker without exposing direct mode actions", () => {
    const key = {
      name: "return",
      sequence: "\r",
      ctrl: false,
      alt: false,
      meta: false,
      shift: false,
      eventType: "press" as const,
    }
    const picker = ViewState.update(
      { ...ViewState.initial("/work"), palette: { open: true, query: "mode Change", selected: 0 } },
      { _tag: "KeyPressed", key },
    )
    expect(picker.modePicker.open).toBe(true)

    const removed = ViewState.update(
      { ...ViewState.initial("/work"), palette: { open: true, query: "mode low", selected: 0 } },
      { _tag: "KeyPressed", key },
    )
    expect(removed.mode).toBe("medium")
    expect(removed.palette.open).toBe(true)

    const unmatched = ViewState.update(
      { ...ViewState.initial("/work"), palette: { open: true, query: "no matching command", selected: 0 } },
      { _tag: "KeyPressed", key },
    )
    expect(unmatched.palette.open).toBe(true)
    expect(unmatched.palette.selected).toBe(0)
    expect(unmatched.pendingAction).toBeUndefined()
  })
})
