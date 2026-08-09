import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import fuzzysort from "fuzzysort"
import { type Component, For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

export const SettingsServersV2: Component = () => {
  const language = useLanguage()
  const controller = useServerManagementController()
  const [store, setStore] = createStore({ filter: "" })
  const showSearch = createMemo(() => controller.sortedItems().length > 1)

  const filtered = createMemo(() => {
    const items = controller.sortedItems()
    const query = store.filter.trim()
    if (!query) return items
    return fuzzysort
      .go(query, items, {
        keys: [(item) => serverName(item), (item) => item.http.url],
      })
      .map((result) => result.obj)
  })

  return (
    <>
      <div
        class="settings-v2-tab-header settings-v2-servers-header"
        classList={{ "settings-v2-tab-header--stacked": showSearch() }}
      >
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("status.popover.tab.servers")}</h2>
        </div>
        <Show when={showSearch()}>
          <div class="settings-v2-tab-search">
            <TextInputV2
              type="search"
              appearance="base"
              value={store.filter}
              onInput={(event) => setStore("filter", event.currentTarget.value)}
              placeholder={language.t("dialog.server.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("dialog.server.search.placeholder")}
            />
            <Show when={store.filter}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="settings-v2-tab-search-clear"
                icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
                onClick={() => setStore("filter", "")}
              />
            </Show>
          </div>
        </Show>
      </div>

      <div class="settings-v2-tab-body settings-v2-servers">
        <Show
          when={filtered().length > 0}
          fallback={
            <div class="settings-v2-servers-status">
              <span>{store.filter ? language.t("palette.empty") : language.t("dialog.server.empty")}</span>
              <Show when={store.filter}>
                <span class="settings-v2-servers-status-filter">&quot;{store.filter}&quot;</span>
              </Show>
            </div>
          }
        >
          <SettingsListV2>
            <For each={filtered()}>
              {(item) => {
                const key = ServerConnection.key(item)
                const health = () => controller.status()[key]
                const isDefault = () => controller.defaultKey() === key
                return (
                  <div class="settings-v2-servers-row">
                    <div class="settings-v2-servers-lead">
                      <ServerHealthIndicator health={health()} />
                      <div class="settings-v2-servers-copy">
                        <span class="settings-v2-servers-name">{serverName(item)}</span>
                        <Show when={health()?.version}>
                          <span class="settings-v2-servers-meta">v{health()?.version}</span>
                        </Show>
                      </div>
                    </div>
                    <Show when={controller.canDefault() && isDefault()}>
                      <div class="settings-v2-servers-actions">
                        <span>{language.t("dialog.server.status.default")}</span>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </SettingsListV2>
        </Show>
      </div>
    </>
  )
}
