import type { FilePart, UserMessage } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useMutation } from "@tanstack/solid-query"
import {
  ErrorBoundary,
  onCleanup,
  Show,
  createMemo,
  createEffect,
  createComputed,
  on,
  onMount,
  type ParentProps,
  untrack,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { createStore } from "solid-js/store"
import { isScrollKeyTarget, scrollKey, scrollKeyOwner } from "@opencode-ai/ui/scroll-view"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { showToast } from "@/utils/toast"
import { useLocation, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { NewSessionView, SessionHeader } from "@/components/session"
import { ErrorPage } from "@/pages/error"
import { CommentsProvider, useComments } from "@/context/comments"
import { useCommand } from "@/context/command"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { useNotification } from "@/context/notification"
import { PromptProvider, usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection, serverName, useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { PromptInput } from "@/components/prompt-input"
import { PromptInputV2Composer, usePromptInputV2Controller } from "@/components/prompt-input-v2"
import { useSettingsCommand } from "@/components/settings-dialog"
import { setCursorPosition } from "@/components/prompt-input/editor-dom"
import { promptLength } from "@/components/prompt-input/history"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import {
  createPromptInputController,
  createSessionComposerController,
  createSessionComposerRegionController,
  SessionComposerRegion,
} from "@/pages/session/composer"
import { MessageTimeline } from "@/pages/session/timeline/message-timeline"
import { createTimelineModel } from "@/pages/session/timeline/model"
import { useSessionLayout } from "@/pages/session/session-layout"
import { restorePromptModel, syncPromptModel, syncSessionModel } from "@/pages/session/session-model-helpers"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { Identifier } from "@/utils/id"
import { Persist, persisted } from "@/utils/persist"
import { formatServerError, isLocalSessionNotFoundError, isSessionNotFoundError } from "@/utils/server-errors"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { createSessionOwnership } from "./session/session-ownership"
import { createSessionLineage } from "./session/session-lineage"

type FollowupItem = FollowupDraft & { id: string }
type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">
const emptyFollowups: FollowupItem[] = []

const sessionViewState = () => ({
  messageId: undefined as string | undefined,
})

function isCurrentSessionNotFoundError(error: unknown, sessionID: string | undefined) {
  if (!sessionID) return false
  return isSessionNotFoundError(error, sessionID) || isLocalSessionNotFoundError(error, sessionID)
}

export function SessionPage() {
  return (
    <SessionProviders>
      <Page />
    </SessionProviders>
  )
}

// Rendered under app.tsx's TargetSessionRoute, which owns the per-server keyed
// remount around the server-scoped providers. Nothing here may key on the
// session ID: session tabs on the same server share this route instance, and
// directory providers live below.
export function TargetSessionRouteContent() {
  const params = useParams<{ serverKey: string; id: string }>()
  const serverSync = useServerSync()
  const serverKey = requireServerKey(params.serverKey)
  const sessionID = params.id
  const directory = createMemo(() => serverSync().session.lineage.peek(sessionID)?.session.directory)
  return (
    // Settings must keep the target-server SDK, sync, and models context and remain registered
    // when session content falls back to the route error boundary.
    <TargetServerScopedProviders directory={directory} sessionID={() => sessionID}>
      <TargetSessionSettingsCommand />
      <SessionRouteErrorBoundary sessionID={sessionID} serverKey={serverKey} padded>
        <ResolvedTargetSessionRoute />
      </SessionRouteErrorBoundary>
    </TargetServerScopedProviders>
  )
}

function TargetSessionSettingsCommand() {
  useSettingsCommand()
  return null
}

export function SessionRouteErrorBoundary(
  props: ParentProps<{ sessionID?: string; serverKey?: ServerConnection.Key; padded?: boolean }>,
) {
  const settings = useSettings()
  return (
    <ErrorBoundary
      fallback={(error) =>
        settings.general.newLayoutDesigns() ? (
          <SessionRouteFrame padded={props.padded}>
            <SessionPanelFrame newLayout raised={!!props.sessionID}>
              <SessionErrorFallback error={error} sessionID={props.sessionID} serverKey={props.serverKey} />
            </SessionPanelFrame>
          </SessionRouteFrame>
        ) : (
          <ErrorPage error={error} />
        )
      }
    >
      {props.children}
    </ErrorBoundary>
  )
}

function SessionErrorFallback(props: { error: unknown; sessionID?: string; serverKey?: ServerConnection.Key }) {
  const language = useLanguage()
  const server = useServer()
  const tabs = useTabs()
  const displayServer = createMemo(() => {
    const key = props.serverKey ?? server.key
    const conn = server.list.find((item) => ServerConnection.key(item) === key)
    return conn ? serverName(conn) : key
  })
  const closeTab = () => {
    if (!props.sessionID) return
    tabs.removeSessionTab({ server: props.serverKey ?? server.key, sessionId: props.sessionID })
  }
  if (isCurrentSessionNotFoundError(props.error, props.sessionID)) {
    return (
      <div class="flex-1 min-h-0 overflow-hidden">
        <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-4">
          <div class="flex flex-col items-center gap-2">
            <div class="text-16-medium text-text max-w-md">{language.t("session.error.notFound")}</div>
            <div class="text-13-regular text-text-weak max-w-md">
              {language.t("session.error.notFound.description")}
            </div>
          </div>
          <Show when={props.sessionID}>
            {(sessionID) => (
              <div class="max-w-full flex flex-col items-center gap-1">
                <div class="max-w-full text-11-regular text-text-faint break-all">{displayServer()}</div>
                <code class="max-w-full rounded-[4px] px-1 py-0.5 font-mono text-xs font-medium leading-4 text-text-base break-all bg-[color-mix(in_oklch,var(--v2-text-text-base)_8%,transparent)]">
                  {sessionID()}
                </code>
              </div>
            )}
          </Show>
          <ButtonV2 variant="neutral" size="normal" icon="xmark-small" onClick={closeTab}>
            {language.t("session.error.notFound.closeTab")}
          </ButtonV2>
        </div>
      </div>
    )
  }
  return <ErrorPage error={props.error} />
}

function ResolvedTargetSessionRoute() {
  const params = useParams<{ serverKey: string; id: string }>()
  const tabs = useTabs()
  const sync = useServerSync()
  const serverKey = createMemo(() => requireServerKey(params.serverKey))
  const current = createSessionLineage(
    () => params.id,
    () => sync().session.lineage,
  )
  const directory = createMemo(() => current()?.session.directory)
  const targetDirectory = () => directory()!

  createEffect(() => {
    const session = current()
    if (!session) return
    tabs.addSessionTab({
      server: serverKey(),
      sessionId: session.root.id,
    })
  })

  return (
    // Non-keyed: closes only while the target's directory is unknown (uncached
    // lineage mid-resolution), which tears down the workspace subtree. Same-
    // workspace tab switches keep it open because warm targets resolve
    // synchronously from the sync cache.
    <Show when={directory()}>
      <SDKProvider directory={targetDirectory}>
        <DirectoryDataProvider directory={targetDirectory} server={serverKey}>
          <TargetSessionPage />
        </DirectoryDataProvider>
      </SDKProvider>
    </Show>
  )
}

// Owns the workspace-identity remount. Must not include the session ID in the
// key: SessionPage handles session changes reactively, and remounting here
// destroys workspace-scoped state (file/prompt providers).
function TargetSessionPage() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  return (
    <Show when={`${serverSDK().scope}\0${sdk().directory}`} keyed>
      <SessionPage />
    </Show>
  )
}

function TargetServerScopedProviders(
  props: ParentProps<{ directory?: () => string | undefined; sessionID?: () => string | undefined }>,
) {
  return (
    <>
      <MarkSessionNotificationsViewed sessionID={props.sessionID} />
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </>
  )
}

function MarkSessionNotificationsViewed(props: { sessionID?: () => string | undefined }) {
  const notification = useNotification()
  createEffect(() => {
    const sessionID = props.sessionID?.()
    if (!notification.ready() || !sessionID) return
    if (notification.session.unseenCount(sessionID) === 0) return
    notification.session.markViewed(sessionID)
  })
  return null
}

function SessionProviders(props: ParentProps) {
  return (
    <PromptProvider>
      <CommentsProvider>{props.children}</CommentsProvider>
    </PromptProvider>
  )
}

function SessionRouteFrame(props: ParentProps<{ padded?: boolean }>) {
  return (
    <div class="relative size-full overflow-hidden flex flex-col" classList={{ "p-2": props.padded }}>
      {props.children}
    </div>
  )
}

function SessionPanelFrame(props: ParentProps<{ newLayout: boolean; raised?: boolean }>) {
  return (
    <div
      classList={{
        "flex-1 min-h-0 flex flex-col": true,
        "bg-v2-background-bg-base": props.newLayout,
        "bg-background-stronger": !props.newLayout,
        "rounded-[10px] overflow-hidden": props.newLayout,
        "shadow-[var(--v2-elevation-raised)]": props.newLayout && props.raised,
      }}
    >
      {props.children}
    </div>
  )
}

export default function Page() {
  const serverSync = useServerSync()
  const layout = useLayout()
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const settings = useSettings()
  const platform = usePlatform()
  const prompt = usePrompt()
  const comments = useComments()
  const command = useCommand()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { params, sessionKey } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const newSessionDesign = createMemo(() => settings.general.newLayoutDesigns())

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const composer = createSessionComposerController()
  const inputController = createPromptInputController({
    sessionKey,
    sessionID: () => params.id,
    queryOptions: serverSync().queryOptions,
  })

  const sessionPanelKey = createMemo(() => (params.id ? `${serverSDK().scope}\0${params.id}` : undefined))

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const centered = createMemo(() => isDesktop())

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const isChildSession = createMemo(() => !!info()?.parentID)
  const timeline = createTimelineModel({ sessionID: () => params.id })
  const historyLoading = timeline.history.loading
  const historyMore = timeline.history.more
  const lastUserMessage = timeline.lastUserMessage
  const messages = timeline.messages
  const messagesReady = timeline.ready
  const sessionSync = timeline.resource
  const visibleUserMessages = timeline.visibleUserMessages

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  let restoredModelSession: string | undefined
  createEffect(() => {
    const id = params.id
    if (!id || !prompt.ready() || !local.session.ready()) return
    if (restoredModelSession !== id) {
      restoredModelSession = id
      if (restorePromptModel(local, prompt)) return
    }
    syncPromptModel(local, prompt)
  })

  createEffect(
    on(
      () => ({ dir: sdk().directory, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    ...sessionViewState(),
    deferRender: false,
  })

  const [followup, setFollowup] = persisted(
    Persist.serverWorkspace(serverSDK().scope, sdk().directory, "followup"),
    createStore<{
      items: Record<string, FollowupItem[] | undefined>
      failed: Record<string, string | undefined>
      paused: Record<string, boolean | undefined>
      edit: Record<string, FollowupEdit | undefined>
    }>({
      items: {},
      failed: {},
      paused: {},
      edit: {},
    }),
  )

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      const owner = sessionOwnership.capture()
      requestAnimationFrame(() => {
        setTimeout(() => owner.run(() => setStore("deferRender", false)), 0)
      })
    }
    return key
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let revealMessage = (_id: string) => {}
  let scrollToEnd = () => {}
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore(sessionViewState())
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => sdk().directory,
      (dir) => {
        if (!dir) return
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "none",
  })
  createEffect(
    on(
      () => params.id,
      (id, previous) => {
        if (!id || !previous || id === previous) return
        if (location.hash || store.messageId || ui.pendingMessage) return
        autoScroll.resume()
      },
    ),
  )

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.resume()
    scrollToEnd()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  let captureHistoryAnchor = () => {}
  let restoreHistoryAnchor = (_done: boolean) => {}
  const historyRequests = new Set<string>()
  let historyContinuationFrame: number | undefined
  const loadOlder = async () => {
    const owner = sessionOwnership.capture()
    if (historyLoading() || historyRequests.has(owner.key)) return
    historyRequests.add(owner.key)
    const before = timeline.messages().length
    try {
      await timeline.history.loadOlder({
        before: () => owner.run(captureHistoryAnchor),
        after: (done) => owner.run(() => restoreHistoryAnchor(done)),
      })
    } finally {
      historyRequests.delete(owner.key)
    }
    if (!owner.current() || timeline.messages().length <= before) return
    if (!autoScroll.userScrolled() || !scroller || scroller.scrollTop >= 200 || !historyMore()) return
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
    historyContinuationFrame = requestAnimationFrame(() => {
      historyContinuationFrame = undefined
      owner.run(onHistoryScroll)
    })
  }
  const onHistoryScroll = () => {
    if (
      historyRequests.has(sessionOwnership.key()) ||
      historyLoading() ||
      !autoScroll.userScrolled() ||
      !scroller ||
      scroller.scrollTop >= 200
    )
      return
    void loadOlder()
  }

  onCleanup(() => {
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (!historyMore()) return

      void loadOlder()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (!more) return
        fill()
      },
      { defer: true },
    ),
  )

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    const key = scrollKey(event)
    if (key) {
      if (!scroller || !isScrollKeyTarget(target ?? null, key)) return
      if (scrollKeyOwner(scroller, target ?? null, key) !== scroller) return
      markScrollGesture(scroller)
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (isChildSession()) return
      const input = inputRef
      if (!input) return
      input.focus()
      setCursorPosition(input, prompt.cursor() ?? promptLength(prompt.current()))
    }
  }

  const focusInput = () => {
    if (isChildSession()) return
    inputRef?.focus()
  }

  useComposerCommands()
  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
  })

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const busy = (sessionID: string) => sync().data.session_working(sessionID)

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; id: string; manual?: boolean }) => {
      const owner = sessionOwnership.capture()
      const item = (followup.items[input.sessionID] ?? []).find((entry) => entry.id === input.id)
      if (!item) return

      if (input.manual) setFollowup("paused", input.sessionID, undefined)
      setFollowup("failed", input.sessionID, undefined)

      const ok = await sendFollowupDraft({
        api: sdk().api.session,
        sync: sync(),
        serverSync: serverSync(),
        draft: item,
        optimisticBusy: item.sessionDirectory === sdk().directory,
      }).catch((err) => {
        setFollowup("failed", input.sessionID, input.id)
        fail(err)
        return false
      })
      if (!ok) return

      setFollowup("items", input.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== input.id))
      if (input.manual) owner.run(resumeScroll)
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && busy(id) && !isChildSession()
  })

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    if (sync().session.get(sessionID)?.parentID) return Promise.resolve()
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followupBusy(sessionID)) return Promise.resolve()

    return followupMutation.mutateAsync({ sessionID, id, manual: opts?.manual })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  // attachment bytes are embedded as a data URL, so downloading always works;
  // revealing requires the on-disk path captured by the client that attached the file
  const openAttachment = (file: FilePart) => {
    const download = () => {
      const anchor = document.createElement("a")
      anchor.href = file.url
      anchor.download = getFilename(file.filename) || "attachment"
      anchor.click()
    }
    const path = file.filename ?? ""
    const absolute = path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(path)
    if (platform.revealPath && absolute) {
      void platform.revealPath(path).then(
        (revealed) => {
          if (!revealed) download()
        },
        () => download(),
      )
      return
    }
    download()
  }

  const actions = { openAttachment }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const item = queuedFollowups()[0]
    if (!item) return
    if (followupBusy(sessionID)) return
    if (followup.failed[sessionID] === item.id) return
    if (followup.paused[sessionID]) return
    if (isChildSession()) return
    if (busy(sessionID)) return

    void sendFollowup(sessionID, item.id)
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) scrollToEnd()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    autoScroll: {
      pause: autoScroll.pause,
      forceScrollToBottom: () => {
        autoScroll.resume()
        scrollToEnd()
      },
    },
    scroller: () => scroller,
    anchor,
    revealMessage: (id) => revealMessage(id),
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  onMount(() => {
    makeEventListener(document, "keydown", handleKeyDown)
  })

  onCleanup(() => {
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  const sessionErrorFallback = (error: unknown, reset: () => void) => {
    createEffect(on(sessionKey, reset, { defer: true }))
    return <SessionErrorFallback error={error} sessionID={params.id} />
  }

  const sessionPanelContent = () => (
    <>
      {sessionSync() ?? ""}
      <div class="flex-1 min-h-0 overflow-hidden">
        <Show
          when={params.id}
          fallback={<NewSessionView />}
        >
          <Show when={messagesReady() ? params.id : undefined} keyed>
            {(_id) => (
              <MessageTimeline
                actions={actions}
                scroll={ui.scroll}
                onResumeScroll={resumeScroll}
                setScrollRef={setScrollRef}
                onScheduleScrollState={scheduleScrollState}
                onAutoScrollHandleScroll={autoScroll.handleScroll}
                onMarkScrollGesture={markScrollGesture}
                hasScrollGesture={hasScrollGesture}
                onUserScroll={markUserScroll}
                onHistoryScroll={onHistoryScroll}
                onAutoScrollInteraction={autoScroll.handleInteraction}
                shouldAnchorBottom={() =>
                  !location.hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()
                }
                centered={centered()}
                setContentRef={(el) => {
                  content = el
                  autoScroll.contentRef(el)

                  const root = scroller
                  if (root) scheduleScrollState(root)
                }}
                userMessages={visibleUserMessages()}
                setHistoryAnchor={(handlers) => {
                  captureHistoryAnchor = handlers.capture
                  restoreHistoryAnchor = handlers.restore
                }}
                anchor={anchor}
                setRevealMessage={(fn) => {
                  revealMessage = fn
                }}
                setScrollToEnd={(fn) => {
                  scrollToEnd = fn
                }}
              />
            )}
          </Show>
        </Show>
      </div>

      <Show when={true}>
        {(_) => {
          const controller = createSessionComposerRegionController({
            state: composer,
            sessionKey,
            sessionID: () => params.id,
            prompt,
            ready: () => !store.deferRender && messagesReady(),
            centered,
            onResponseSubmit: resumeScroll,
            openParent: () => {
              const id = info()?.parentID
              if (!id) return
              navigate(
                params.serverKey
                  ? sessionHref(requireServerKey(params.serverKey), id)
                  : legacySessionHref(sdk().directory, id),
              )
            },
            setPromptRef: (el) => {
              inputRef = el
            },
            setDockRef: (el) => {
              promptDock = el
            },
          })
          return (
            <SessionComposerRegion
              controller={controller}
              promptInput={
                <Show
                  when={newSessionDesign()}
                  fallback={
                    <PromptInput
                      controls={inputController()}
                      ref={(el) => {
                        inputRef = el
                      }}
                      onSubmit={() => {
                        comments.clear()
                        resumeScroll()
                      }}
                      edit={editingFollowup()}
                      onEditLoaded={clearFollowupEdit}
                      shouldQueue={queueEnabled}
                      onQueue={queueFollowup}
                      onAbort={() => {
                        const id = params.id
                        if (!id) return
                        setFollowup("paused", id, true)
                      }}
                    />
                  }
                >
                  {(_) => {
                    const controller = usePromptInputV2Controller({
                      get controls() {
                        return inputController()
                      },
                      ref: (el) => {
                        inputRef = el
                      },
                      onSubmit: () => {
                        comments.clear()
                        resumeScroll()
                      },
                      get edit() {
                        return editingFollowup()
                      },
                      onEditLoaded: clearFollowupEdit,
                      shouldQueue: queueEnabled,
                      onQueue: queueFollowup,
                      onAbort: () => {
                        const id = params.id
                        if (!id) return
                        setFollowup("paused", id, true)
                      },
                    })
                    return <PromptInputV2Composer controller={controller} borderUnderlay />
                  }}
                </Show>
              }
            />
          )
        }}
      </Show>
    </>
  )

  return (
    <SessionRouteFrame>
      <SessionHeader />
      <div class="flex-1 min-h-0 flex flex-col">
        <div class="@container relative flex flex-col min-h-0 h-full flex-1">
          {settings.general.newLayoutDesigns() ? (
            <Show when={sessionPanelKey()} keyed>
              {(_) => (
                <SessionPanelFrame newLayout raised={!!params.id}>
                  <ErrorBoundary fallback={sessionErrorFallback}>{sessionPanelContent()}</ErrorBoundary>
                </SessionPanelFrame>
              )}
            </Show>
          ) : (
            <SessionPanelFrame newLayout={false} raised={!!params.id}>
              {sessionPanelContent()}
            </SessionPanelFrame>
          )}
        </div>
      </div>
    </SessionRouteFrame>
  )
}
