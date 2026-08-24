import { describe, expect, it } from "@effect/vitest"
import type { Block } from "@rika/product/execution-transcript-contract"
import { Response } from "tenetkit"
import { Cell as TenetCell } from "tenetkit/repl"
import type { RunEvent } from "tenetkit/runtime"
import { TreeProjector } from "../../../src/projection/tree/projector"
import { block, modelResponse, resetEventPosition, treeEvent } from "../../support/projector-event.fixture"

type Cell = Extract<Block, { readonly _tag: "Cell" }>
type Change = ReturnType<ReturnType<typeof TreeProjector.make>["apply"]>
type ToolProgressData = NonNullable<Extract<RunEvent.RunEvent, { readonly _tag: "ToolProgress" }>["data"]>
type ToolResult = Extract<RunEvent.RunEvent, { readonly _tag: "ToolExecutionCompleted" }>["result"]["result"]
type RunEventInput<Tag extends RunEvent.RunEvent["_tag"]> = Partial<
  Extract<RunEvent.RunEvent, { readonly _tag: Tag }>
> & { readonly _tag: Tag }

const cellOf = (change: Change): Cell | undefined => {
  const content = block(change, "Cell")
  return content?._tag === "Block" && content.block._tag === "Cell" ? content.block : undefined
}

const call = (id: string, code: string) =>
  Response.toolCallPart({
    id,
    name: "typescript",
    params: { code },
    providerExecuted: false,
    metadata: {},
  })

const started = (id: string, code: string) => {
  const event: RunEventInput<"ToolExecutionStarted"> = {
    _tag: "ToolExecutionStarted",
    turn: 0,
    call: call(id, code),
  }
  return treeEvent("raw-root-run", event)
}

const progress = (id: string, data: ToolProgressData) => {
  const event: RunEventInput<"ToolProgress"> = {
    _tag: "ToolProgress",
    turn: 0,
    toolCallId: id,
    message: String(data._tag),
    data,
  }
  return treeEvent("raw-root-run", event)
}

const completed = (id: string, code: string, result: ToolResult, isFailure: boolean) => {
  const event: RunEventInput<"ToolExecutionCompleted"> = {
    _tag: "ToolExecutionCompleted",
    turn: 0,
    call: call(id, code),
    result: Response.toolResultPart({
      id,
      name: "typescript",
      result,
      encodedResult: {},
      isFailure,
      providerExecuted: false,
      preliminary: false,
      metadata: {},
    }),
  }
  return treeEvent("raw-root-run", event)
}

describe("TenetKit cell projection", () => {
  it("opens a running cell with summary, visual, and line counts from the call source", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-open", "run a cell")
    const opened = cellOf(projector.apply(started("cell-1", "// warm up\nconst answer = 6 * 7\nanswer")))
    expect(opened).toMatchObject({
      status: "running",
      visual: "ts",
      summary: "const answer = 6 * 7",
      source: { lines: 3, truncated: false },
      output: { stdout: "", stderr: "", droppedBytes: 0, droppedEvents: 0 },
      epoch: 0,
      notices: [],
      files: [],
    })
    expect(opened?.source.text).toBe("// warm up\nconst answer = 6 * 7\nanswer")
    expect(opened?.durationMillis).toBeUndefined()
  })

  it("detects the shell visual for one Bun process statement", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-shell", "shell out")
    expect(cellOf(projector.apply(started("cell-shell", "await Bun.$`bun test`")))?.visual).toBe("shell")
  })

  it("streams stdout and stderr while the cell is still running", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-stream", "stream")
    projector.apply(started("cell-2", "console.log('live')"))
    projector.apply(progress("cell-2", { _tag: "Stdout", cellId: "cell-2", sequence: 0, text: "first " }))
    projector.apply(progress("cell-2", { _tag: "Stderr", cellId: "cell-2", sequence: 1, text: "warn" }))
    const streamed = cellOf(
      projector.apply(progress("cell-2", { _tag: "Stdout", cellId: "cell-2", sequence: 2, text: "second" })),
    )
    expect(streamed).toMatchObject({ status: "running", output: { stdout: "first second", stderr: "warn" } })
  })

  it("settles a completed cell with result, output, duration, epoch, and truncation counts", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-complete", "complete")
    projector.apply(started("cell-3", "6 * 7"))
    const settled = cellOf(
      projector.apply(
        completed(
          "cell-3",
          "6 * 7",
          {
            cellId: "cell-3",
            epoch: 2,
            sequence: 4,
            value: "42",
            stdout: "printed\n",
            stderr: "",
            durationMillis: 1_240,
            truncation: [
              { channel: "stdout", droppedBytes: 128, droppedEvents: 2 },
              { channel: "stderr", droppedBytes: 8, droppedEvents: 1 },
            ],
          },
          false,
        ),
      ),
    )
    expect(settled).toMatchObject({
      status: "complete",
      result: "42",
      durationMillis: 1_240,
      epoch: 2,
      output: { stdout: "printed\n", stderr: "", droppedBytes: 136, droppedEvents: 3 },
    })
  })

  it("keeps streamed output when the cell throws and carries the typed error", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-failed", "fail")
    projector.apply(started("cell-4", "throw new Error('boom')"))
    projector.apply(progress("cell-4", { _tag: "Stdout", cellId: "cell-4", sequence: 0, text: "before throw" }))
    const failed = cellOf(
      projector.apply(
        completed(
          "cell-4",
          "throw new Error('boom')",
          TenetCell.CellExecutionFailed.make({
            _tag: "tenetkit/repl/CellExecutionFailed",
            cellId: "cell-4",
            epoch: 1,
            sequence: 3,
            name: "TypeError",
            message: "boom",
            stack: "at cell:1:1",
            stdout: "before throw",
            stderr: "trace",
            durationMillis: 12,
            truncation: [],
          }),
          true,
        ),
      ),
    )
    expect(failed).toMatchObject({
      status: "failed",
      error: { name: "TypeError", message: "boom", stack: "at cell:1:1" },
      output: { stdout: "before throw", stderr: "trace" },
      durationMillis: 12,
      epoch: 1,
    })
  })

  it("marks an unknown outcome and raises a recovery card without replaying the cell", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-unknown", "unknown")
    projector.apply(started("cell-5", "await rika.workspace.write({ path: 'a', content: 'b' })"))
    const change = projector.apply(
      completed(
        "cell-5",
        "await rika.workspace.write({ path: 'a', content: 'b' })",
        {
          _tag: "tenetkit/repl/CellOutcomeUnknown",
          sessionId: "session",
          cellId: "cell-5",
          epoch: 0,
          reason: "host-terminated",
          message: "The host stopped.",
        },
        true,
      ),
    )
    expect(cellOf(change)).toMatchObject({ status: "unknown" })
    expect(block(change, "Error")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ title: "Cell outcome unknown" }),
    })
  })

  it("reports an unavailable kernel as a failed cell with a diagnostic block", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-unavailable", "unavailable")
    projector.apply(started("cell-6", "1 + 1"))
    const change = projector.apply(
      completed(
        "cell-6",
        "1 + 1",
        {
          _tag: "tenetkit/repl/KernelUnavailable",
          sessionId: "session",
          reason: "start-failed",
          message: "no worker",
        },
        true,
      ),
    )
    expect(cellOf(change)).toMatchObject({ status: "failed" })
    expect(block(change, "Error")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ title: "Kernel unavailable" }),
    })
  })

  it("records restore, loss, and restart notices on the observing cell", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-notices", "notices")
    projector.apply(started("cell-7", "total"))
    projector.apply(
      progress("cell-7", {
        _tag: "StateRestored",
        cellId: "cell-7",
        sequence: 0,
        epoch: 1,
        names: ["total", "rows"],
        restoredBySource: [],
      }),
    )
    projector.apply(
      progress("cell-7", {
        _tag: "StateLost",
        cellId: "cell-7",
        sequence: 1,
        epoch: 1,
        droppedNames: ["handle"],
        reason: "live-handle",
      }),
    )
    const change = projector.apply(
      progress("cell-7", {
        _tag: "KernelRestarted",
        cellId: "cell-7",
        sequence: 2,
        sessionId: "session",
        epoch: 2,
        reason: "crashed",
      }),
    )
    expect(cellOf(change)?.notices).toEqual([
      { kind: "restored", detail: "Restored total, rows." },
      { kind: "lost", detail: "Lost handle (live-handle)." },
      { kind: "restarted", detail: "Kernel restarted (crashed) at epoch 2." },
    ])
    expect(cellOf(change)?.epoch).toBe(2)
    expect(block(change, "Notification")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ title: "Kernel restarted" }),
    })
  })

  it("does not surface kernel starting or ready as cell notices", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-no-kernel-noise", "quiet")
    projector.apply(started("cell-8", "const keep = 1"))
    // A fresh kernel boot (idle-restart or session start) used to attach a
    // "Kernel ready at profile <digest>." notice to the open cell; the profile
    // digest is unactionable and the state that matters is carried by the
    // restored/lost/restarted notices, which are asserted separately.
    const change = projector.apply(
      progress("cell-8", {
        _tag: "KernelStarting",
        cellId: "cell-8",
        sequence: 0,
        sessionId: "session",
        epoch: 1,
      }),
    )
    projector.apply(
      progress("cell-8", {
        _tag: "KernelReady",
        cellId: "cell-8",
        sequence: 1,
        sessionId: "session",
        epoch: 1,
        profileDigest: "profile",
      }),
    )
    projector.apply(completed("cell-8", "const keep = 1", { value: "1", stdout: "", stderr: "" }, false))
    expect(cellOf(change)?.notices).toEqual([{ kind: "starting", detail: "Starting the kernel." }])
    expect(cellOf(change)?.epoch).toBe(1)
  })

  it("bounds streamed output and authored source", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-bounded", "bounded")
    const source = `const value = "${"s".repeat(100_000)}"`
    const opened = cellOf(projector.apply(started("cell-8", source)))
    expect(opened?.source.truncated).toBe(true)
    expect(opened?.source.text.length).toBe(65_536)
    let bounded: Cell | undefined
    for (let index = 0; index < 4; index += 1)
      bounded = cellOf(
        projector.apply(
          progress("cell-8", { _tag: "Stdout", cellId: "cell-8", sequence: index, text: "o".repeat(8_000) }),
        ),
      )
    expect(bounded?.output.stdout.length).toBe(16_384)
    expect(bounded?.output.stdout.startsWith("…")).toBe(true)
  })

  it("accumulates truncation markers streamed before completion", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-truncated", "truncated")
    projector.apply(started("cell-9", "noisy()"))
    projector.apply(
      progress("cell-9", {
        _tag: "OutputTruncated",
        cellId: "cell-9",
        sequence: 0,
        channel: "stdout",
        droppedBytes: 64,
        droppedEvents: 1,
      }),
    )
    const change = projector.apply(
      progress("cell-9", {
        _tag: "OutputTruncated",
        cellId: "cell-9",
        sequence: 1,
        channel: "stderr",
        droppedBytes: 32,
        droppedEvents: 2,
      }),
    )
    expect(cellOf(change)?.output).toMatchObject({ droppedBytes: 96, droppedEvents: 3 })
  })

  it("renders an emitted image artifact as an ImageAttachment block", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-image", "image")
    projector.apply(started("cell-10", "await rika.media.attach({ path: 'a.png' })"))
    const change = projector.apply(
      progress("cell-10", {
        _tag: "Display",
        cellId: "cell-10",
        sequence: 0,
        mediaType: "image/png",
        data: "abcd",
        name: "a.png",
      }),
    )
    expect(block(change, "ImageAttachment")).toEqual({
      _tag: "Block",
      block: { _tag: "ImageAttachment", name: "a.png", mediaType: "image/png", bytes: 4 },
    })
  })

  it("renders an emitted diff artifact through the existing file presentation", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-diff", "diff")
    projector.apply(started("cell-11", "await rika.workspace.replace({ path: 'a.ts' })"))
    const change = projector.apply(
      progress("cell-11", {
        _tag: "Display",
        cellId: "cell-11",
        sequence: 0,
        mediaType: "text/x-diff",
        data: "--- a/a.ts\n+++ b/a.ts\n-old\n+new",
        name: "a.ts",
      }),
    )
    expect(cellOf(change)?.files).toEqual([
      expect.objectContaining({ path: "a.ts", kind: "update", additions: 1, deletions: 1, preview: false }),
    ])
  })

  it("records a nested host operation as a status-only activity notice", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-nested", "nested")
    projector.apply(started("cell-nested", "await rika.media.attach({ path: 'a.png' })"))
    projector.apply(
      progress("cell-nested", { nestedOperation: { kind: "media.attach", ordinal: 0, status: "running" } }),
    )
    const change = projector.apply(
      progress("cell-nested", { nestedOperation: { kind: "media.attach", ordinal: 0, status: "succeeded" } }),
    )
    expect(cellOf(change)?.notices).toEqual([
      { kind: "activity", detail: "media.attach running" },
      { kind: "activity", detail: "media.attach succeeded" },
    ])
  })

  it("does not invent an image or diff from a nested host operation, because no producer sends one", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-nested-empty", "nested only")
    projector.apply(started("cell-nested-2", "await rika.workspace.replace({ path: 'a.ts' })"))
    const change = projector.apply(
      progress("cell-nested-2", { nestedOperation: { kind: "workspace.replace", ordinal: 0, status: "succeeded" } }),
    )
    expect(cellOf(change)?.files).toEqual([])
    expect(block(change, "ImageAttachment")).toBeUndefined()
  })

  it("projects the complete authored source from a committed tool call", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-source", "source")
    const projected = cellOf(
      projector.apply(
        modelResponse("raw-root-run", {
          type: "tool-call",
          id: "cell-12",
          name: "typescript",
          params: { code: "const a = 1" },
          providerExecuted: false,
          metadata: {},
        }),
      ),
    )
    expect(projected).toMatchObject({ status: "running", summary: "const a = 1" })
    expect(projected?.source.text).toBe("const a = 1")
  })

  it("cancels a still-running cell when the run settles", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-cancel", "cancel")
    projector.apply(started("cell-13", "await forever()"))
    const change = projector.apply(treeEvent("raw-root-run", { _tag: "RunCancelled", reason: "interrupted" }))
    expect(cellOf(change)).toMatchObject({ status: "cancelled" })
  })

  it("never emits a tool block for the cell tool", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-no-tool", "no tool")
    const change = projector.apply(started("cell-14", "1"))
    expect(block(change, "ToolCall")).toBeUndefined()
  })
})
