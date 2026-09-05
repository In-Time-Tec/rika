// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Scene } from "foldkit/test"
import { Schema } from "effect"
import { ThreadSummary } from "@rika/product/thread-summary"
import { protocolVersion } from "@rika/product/client-protocol"
import {
  ChangedThreadId,
  ClickedConnect,
  ConnectedThread,
  FailedThreadConnection,
  GotThreadFrame,
  RefreshThreads,
  LoadedThreads,
  init,
  update,
  view,
  type Model,
  type Message,
} from "../../src/client/main"
import { markdown, safeLink } from "../../src/client/transcript"
import { reviewSnapshot } from "./review.fixture"

describe("FoldKit Thread review", () => {
  it("renders semantic roles, tool results and diffs with no mutation controls", () => {
    const [initial] = init()
    const loaded: Model = {
      ...initial,
      loadingThreads: false,
      connection: "connected",
      threadId: reviewSnapshot.thread.id,
      attachedThreadId: reviewSnapshot.thread.id,
      snapshot: reviewSnapshot,
    }
    Scene.scene<Model, Message>(
      { update, view },
      Scene.given(loaded),
      Scene.expect(Scene.role("heading", { name: "User" })).toExist(),
      Scene.expect(Scene.role("heading", { name: "Changes ready for review" })).toExist(),
      Scene.expect(Scene.selector(".tool-complete")).toHaveText(/edit.*complete/),
      Scene.expect(Scene.selector(".diff summary")).toHaveText(/src\/navigation.ts/),
      Scene.expect(Scene.selector(".diff pre")).toHaveText(/await attachThread/),
      Scene.expect(Scene.selector(".removed")).toHaveText(/clearTranscript/),
      Scene.expect(Scene.selector("textarea")).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Cancel" })).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Approve" })).toBeAbsent(),
    )
  })

  it("ignores superseded connections and foreign events, and recovers the committed identity", () => {
    const [initial] = init()
    const [a] = update(initial, ChangedThreadId({ value: "a" }))
    const [connecting, commands] = update(a, ClickedConnect())
    expect(commands[0]?.name).toBe("ConnectThread")
    const [connected] = update(
      connecting,
      ConnectedThread({
        epoch: 1,
        threadId: "a",
        frame: { protocolVersion, payload: { _tag: "ThreadAttached", threadId: "a" } },
      }),
    )
    expect(update(connected, FailedThreadConnection({ epoch: 0, message: "stale" }))[0]).toBe(connected)
    expect(
      update(
        connected,
        GotThreadFrame({ frame: { protocolVersion, payload: { _tag: "ThreadSnapshot", threadId: "b" } } }),
      )[0],
    ).toBe(connected)
    const [recovering] = update(
      connected,
      GotThreadFrame({ frame: { protocolVersion, payload: { _tag: "ClientReconnecting", threadId: "a" } } }),
    )
    expect(recovering.connection).toBe("connecting")
    const [recovered] = update(
      recovering,
      GotThreadFrame({ frame: { protocolVersion, payload: { _tag: "ThreadAttached", threadId: "a" } } }),
    )
    expect(recovered.connection).toBe("connected")
  })

  it("loads cross-session navigation, filters archived Threads, and ignores stale lists", () => {
    const [initial] = init()
    const threads = Schema.decodeSync(Schema.Array(ThreadSummary))([
      {
        id: "a",
        workspace: "workspace",
        title: "Active work",
        status: "idle",
        turnCount: 1,
        lastActivityAt: 1,
        pinned: false,
        archived: false,
        unread: false,
      },
      {
        id: "b",
        workspace: "workspace",
        title: "Archived work",
        status: "idle",
        turnCount: 2,
        lastActivityAt: 1,
        pinned: false,
        archived: true,
        unread: false,
      },
    ])
    const [loaded] = update(initial, LoadedThreads({ epoch: 1, threads }))
    const [refreshing] = update(loaded, RefreshThreads())
    expect(update(refreshing, LoadedThreads({ epoch: 1, threads: [] }))[0]).toBe(refreshing)
    Scene.scene<Model, Message>(
      { update, view },
      Scene.given(loaded),
      Scene.expect(Scene.role("button", { name: /Active work/ })).toExist(),
      Scene.expect(Scene.role("button", { name: /Archived work/ })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Show archived Threads" })),
      Scene.expect(Scene.role("button", { name: /Archived work/ })).toExist(),
      Scene.expect(Scene.role("button", { name: "Send" })).toBeAbsent(),
    )
  })

  it("renders Markdown without executable HTML, unsafe URLs or remote images", () => {
    const render = (text: string) =>
      Scene.scene(
        { update: (state: string) => [state, []], view: markdown },
        Scene.given(text),
        Scene.expect(Scene.selector("script")).toBeAbsent(),
        Scene.expect(Scene.selector("img")).toBeAbsent(),
        Scene.expect(Scene.selector('a[href^="javascript:"]')).toBeAbsent(),
        Scene.expect(Scene.selector('a[href^="data:"]')).toBeAbsent(),
      )
    render(
      "<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) ![remote](https://tracking.invalid/pixel) [bad](data:text/html,evil)",
    )
    for (const link of ["javascript:alert(1)", "data:text/html,x", "vbscript:msgbox(1)", "java\nscript:x"])
      expect(safeLink(link)).toBe(false)
    for (const partial of [
      "**stream",
      "**streamed** [reference][r]",
      "**streamed** [reference][r]\n\n[r]: https://example.com",
    ])
      render(partial)
    Scene.scene(
      { update: (state: string) => [state, []], view: markdown },
      Scene.given("**streamed** [reference][r]\n\n[r]: https://example.com"),
      Scene.expect(Scene.selector("strong")).toHaveText("streamed"),
      Scene.expect(Scene.role("link", { name: "reference" })).toHaveAttr("href", "https://example.com"),
      Scene.expect(Scene.selector(".markdown")).toHaveText("streamed reference"),
    )
  })
})
