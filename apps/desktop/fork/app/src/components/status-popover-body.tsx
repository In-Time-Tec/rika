import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { List } from "@opencode-ai/ui/list"
import { useNavigate } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { type Platform, usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import type { ServerHealth } from "@/utils/server-health"

const listServersByHealth = (
  list: ServerConnection.Any[],
  active: ServerConnection.Key | undefined,
  status: Record<ServerConnection.Key, ServerHealth | undefined>,
) => {
  const order = new Map(list.map((conn, index) => [conn, index] as const))
  const rank = (value?: ServerHealth) => (value?.healthy === true ? 0 : value?.healthy === false ? 2 : 1)
  return list.slice().sort((a, b) => {
    if (ServerConnection.key(a) === active) return -1
    if (ServerConnection.key(b) === active) return 1
    const diff = rank(status[ServerConnection.key(a)]) - rank(status[ServerConnection.key(b)])
    return diff || (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

const useDefaultServerKey = (get: Platform["getDefaultServer"] | undefined) => {
  const [state, setState] = createStore({ key: undefined as ServerConnection.Key | undefined, tick: 0 })
  createEffect(() => {
    state.tick
    let dead = false
    const result = get?.()
    if (!result) {
      setState("key", undefined)
      return
    }
    void Promise.resolve(result).then((key) => {
      if (!dead) setState("key", key ?? undefined)
    })
    onCleanup(() => {
      dead = true
    })
  })
  return {
    key: () => state.key,
    refresh: () => setState("tick", (value) => value + 1),
  }
}

type ServerStatusItem = {
  key: ServerConnection.Key
  conn: ServerConnection.Any
  health?: ServerHealth
  blocked: boolean
  active: boolean
  onSelect: () => void
}

type ServerStatusState = {
  servers: () => ServerStatusItem[]
  defaultKey: () => ServerConnection.Key | undefined
  ariaLabel: string
  serversLabel: string
  defaultLabel: string
  manageLabel: string
  onManage: () => void
}

export function StatusPopoverServerBody() {
  const global = useGlobal()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const defaultServer = useDefaultServerKey(platform.getDefaultServer)
  let dialogRun = 0
  let dead = false
  onCleanup(() => {
    dead = true
    dialogRun += 1
  })

  const serverItems = createMemo(() =>
    listServersByHealth(global.servers.list(), server.key, global.servers.health).map((conn) => {
      const key = ServerConnection.key(conn)
      const health = global.servers.health[key]
      return {
        key,
        conn,
        health,
        blocked: health?.healthy === false,
        active: key === ServerConnection.key(server.current ?? conn),
        onSelect: () => {
          navigate("/")
          queueMicrotask(() => server.setActive(key))
        },
      }
    }),
  )

  return (
    <ServerStatusPopoverView
      state={{
        servers: serverItems,
        defaultKey: defaultServer.key,
        ariaLabel: language.t("status.popover.ariaLabel"),
        serversLabel: language.t("status.popover.tab.servers"),
        defaultLabel: language.t("common.default"),
        manageLabel: language.t("status.popover.action.manageServers"),
        onManage: () => {
          const run = ++dialogRun
          void import("./dialog-select-server").then((module) => {
            if (dead || run !== dialogRun) return
            dialog.show(() => <module.DialogSelectServer />, defaultServer.refresh)
          })
        },
      }}
    />
  )
}

function ServerStatusPopoverView(props: { state: ServerStatusState }) {
  return (
    <div class="flex flex-col w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
      <div class="px-4 pt-3 pb-2 text-12-regular text-text-weak">
        {props.state.servers().length > 0 ? `${props.state.servers().length} ` : ""}
        {props.state.serversLabel}
      </div>
      <div class="flex flex-col px-2 pb-2">
        <List
          class="[&_[data-slot=list-items]]:bg-background-base [&_[data-slot=list-items]]:rounded-sm"
          items={props.state.servers}
          key={(item) => item.key}
          noInitialSelection
          search={false}
        >
          {(item) => (
            <button
              type="button"
              class="flex items-center gap-2 w-full h-10 px-3 rounded-md text-left"
              classList={{
                "hover:bg-surface-raised-base-hover": !item.blocked,
                "cursor-not-allowed": item.blocked,
              }}
              aria-disabled={item.blocked}
              onClick={() => {
                if (!item.blocked) item.onSelect()
              }}
            >
              <ServerHealthIndicator health={item.health} />
              <ServerRow
                conn={item.conn}
                dimmed={item.blocked}
                status={item.health}
                class="flex items-center gap-2 w-full min-w-0"
                nameClass="text-14-regular text-text-base truncate"
                versionClass="text-12-regular text-text-weak truncate"
              >
                <div class="flex-1" />
                <Show when={item.active}>
                  <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                </Show>
              </ServerRow>
            </button>
          )}
        </List>
        <Button variant="secondary" class="mt-3 self-start h-8 px-3 py-1.5" onClick={props.state.onManage}>
          {props.state.manageLabel}
        </Button>
      </div>
    </div>
  )
}

export function StatusPopoverBody(_props: { shown: Accessor<boolean> }) {
  return <StatusPopoverServerBody />
}
