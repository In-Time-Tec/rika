import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { List } from "@opencode-ai/ui/list"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, Show } from "solid-js"
import { showToast } from "@/utils/toast"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import type { ServerHealth } from "@/utils/server-health"
import { useSettings } from "@/context/settings"

function showRequestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

function useDefaultServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const [defaultKey, defaultUrlActions] = createResource(
    async () => {
      try {
        const key = await platform.getDefaultServer?.()
        if (!key) return null
        return key
      } catch (err) {
        showRequestError(language, err)
        return null
      }
    },
    { initialValue: null },
  )

  const canDefault = createMemo(() => !!platform.getDefaultServer && !!platform.setDefaultServer)
  const setDefault = async (key: ServerConnection.Key | null) => {
    try {
      await platform.setDefaultServer?.(key)
      defaultUrlActions.mutate(key)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return { defaultKey: () => defaultKey.latest, canDefault, setDefault }
}

export function DialogSelectServer() {
  const dialog = useDialog()
  const controller = useServerManagementController({ onSelect: dialog.close })
  const language = useLanguage()

  return (
    <Dialog title={language.t("dialog.server.title")}>
      <div class="flex flex-1 min-h-0 flex-col px-5">
        <ServerConnectionList controller={controller} />
      </div>
    </Dialog>
  )
}

export function useServerManagementController(options: { onSelect?: () => void } = {}) {
  const navigate = useNavigate()
  const server = useServer()
  const global = useGlobal()
  const platform = usePlatform()
  const language = useLanguage()
  const settings = useSettings()
  const { defaultKey, canDefault, setDefault } = useDefaultServer()

  const items = createMemo(() => {
    const current = server.current?.type === "rika" ? server.current : undefined
    const list = server.list.filter((conn): conn is ServerConnection.Rika => conn.type === "rika")
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const current = createMemo<ServerConnection.Rika | undefined>(() =>
    settings.general.newLayoutDesigns()
      ? undefined
      : (items().find((x) => ServerConnection.key(x) === server.key) ?? items()[0]),
  )

  const sortedItems = createMemo(() => {
    const list = items()
    if (!list.length) return list
    const active = current()
    const order = new Map(list.map((conn, index) => [conn, index] as const))
    const rank = (value?: ServerHealth) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    return list.slice().sort((a, b) => {
      if (a === active) return -1
      if (b === active) return 1
      const diff =
        rank(global.servers.health[ServerConnection.key(a)]) - rank(global.servers.health[ServerConnection.key(b)])
      if (diff !== 0) return diff
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })

  async function select(conn: ServerConnection.Rika) {
    if (global.servers.health[ServerConnection.key(conn)]?.healthy === false) return
    options.onSelect?.()
    navigate("/")
    queueMicrotask(() => server.setActive(ServerConnection.key(conn)))
  }

  return {
    defaultKey,
    canDefault,
    current,
    sortedItems,
    status: () => global.servers.health,
    select,
    setDefault,
  }
}

export function ServerConnectionList(props: { controller: ReturnType<typeof useServerManagementController> }) {
  const language = useLanguage()

  return (
    <div class="flex flex-1 min-h-0 flex-col gap-4">
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-search-wrapper]]:w-full [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:overflow-y-auto [&_[data-slot=list-items]]:bg-surface-base [&_[data-slot=list-items]]:rounded-md [&_[data-slot=list-item]]:min-h-14 [&_[data-slot=list-item]]:p-3 [&_[data-slot=list-item]]:!bg-transparent"
        search={{
          placeholder: language.t("dialog.server.search.placeholder"),
          autofocus: false,
        }}
        noInitialSelection
        emptyMessage={language.t("dialog.server.empty")}
        items={props.controller.sortedItems}
        key={(conn) => ServerConnection.key(conn)}
        onSelect={(conn) => {
          if (conn) void props.controller.select(conn)
        }}
        divider={true}
      >
        {(conn) => {
          const key = ServerConnection.key(conn)
          return (
            <div class="flex items-center gap-3 min-w-0 flex-1 w-full group/item">
              <div class="flex flex-col h-full items-center w-5">
                <ServerHealthIndicator health={props.controller.status()[key]} />
              </div>
              <ServerRow
                conn={conn}
                dimmed={props.controller.status()[key]?.healthy === false}
                status={props.controller.status()[key]}
                class="flex items-center gap-3 min-w-0 flex-1"
                badge={
                  <Show when={props.controller.defaultKey() === key}>
                    <span class="text-text-base bg-surface-base text-14-regular px-1.5 rounded-xs">
                      {language.t("dialog.server.status.default")}
                    </span>
                  </Show>
                }
              />
              <Show when={props.controller.current() && ServerConnection.key(props.controller.current()!) === key}>
                <Icon name="check" class="h-6" />
              </Show>
            </div>
          )
        }}
      </List>
    </div>
  )
}
