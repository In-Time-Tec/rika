import { getFilename } from "@opencode-ai/core/util/path"
import type { Project } from "@opencode-ai/sdk/v2/client"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, onCleanup } from "solid-js"
import { commandPaletteOptions, useCommand, type CommandOption } from "@/context/command"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import type { LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useTabs } from "@/context/tabs"
import { displayName, projectForSession } from "@/pages/layout/helpers"
import { normalizeSessionInfo } from "@/utils/session"

export type CommandPaletteEntry = {
  id: string
  type: "command" | "session"
  title: string
  description?: string
  keybind?: string
  category: string
  option?: CommandOption
  directory?: string
  sessionID?: string
  server?: ServerConnection.Key
  project?: LocalProject
  archived?: number
  updated?: number
}

const ENTRY_LIMIT = 5
const COMMON_COMMAND_IDS = [
  "session.new",
  "workspace.new",
  "session.previous",
  "session.next",
  "review.toggle",
] as const

export function uniqueCommandPaletteEntries(items: CommandPaletteEntry[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export function createCommandPaletteModel() {
  const command = useCommand()
  const global = useGlobal()
  const language = useLanguage()
  const dialog = useDialog()
  const serverSDK = useServerSDK()()
  const serverCtx = global.ensureServerCtx(serverSDK.server)
  const appTabs = useTabs()
  const state = { cleanup: undefined as (() => void) | void, committed: false }

  const commandEntries = createMemo(() => {
    const category = language.t("palette.group.commands")
    return commandPaletteOptions(command.options).map((option) => createCommandPaletteCommandEntry(option, category))
  })
  const preferredCommandEntries = createMemo(() => {
    const all = commandPaletteOptions(command.options)
    const order = new Map<string, number>(COMMON_COMMAND_IDS.map((id, index) => [id, index]))
    const picked = all.filter((option) => order.has(option.id))
    const base = picked.length ? picked : all.slice(0, ENTRY_LIMIT)
    const sorted = picked.length ? [...base].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)) : base
    const category = language.t("palette.group.commands")
    return sorted.map((option) => createCommandPaletteCommandEntry(option, category))
  })

  const sessions = createServerSessionEntries({
    server: ServerConnection.key(serverSDK.server),
    opened: serverCtx.projects.list,
    stored: () => serverCtx.sync.data.project,
    load: (search, signal) => serverSDK.api.session.list({ parentID: null, search, limit: 50 }, { signal }),
    untitled: () => language.t("command.session.new"),
    category: () => language.t("command.category.session"),
  })

  const highlight = (item: CommandPaletteEntry | undefined) => {
    state.cleanup?.()
    state.cleanup = undefined
    if (item?.type !== "command") return
    state.cleanup = item.option?.onHighlight?.()
  }

  const select = (item: CommandPaletteEntry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = undefined
    dialog.close()
    if (item.type === "command") {
      item.option?.onSelect?.("palette")
      return
    }
    if (!item.sessionID || !item.server) return
    const directory = item.project?.worktree ?? item.directory
    if (directory) {
      serverCtx.projects.open(directory)
      serverCtx.projects.touch(directory)
    }
    const tab = appTabs.addSessionTab({
      server: item.server,
      sessionId: item.sessionID,
    })
    appTabs.select(tab)
  }

  onCleanup(() => {
    if (state.committed) return
    state.cleanup?.()
  })

  return {
    language,
    commandEntries,
    preferredCommandEntries,
    sessions,
    highlight,
    select,
    close: () => dialog.close(),
  }
}

export function createCommandPaletteCommandEntry(option: CommandOption, category: string): CommandPaletteEntry {
  return {
    id: "command:" + option.id,
    type: "command",
    title: option.title,
    description: option.description,
    keybind: option.keybind,
    category,
    option,
  }
}

export function createServerSessionEntries(props: {
  server: ServerConnection.Key
  opened: () => LocalProject[]
  stored: () => Project[]
  load: (search: string, signal: AbortSignal) => Promise<{ data: SessionInfo[] }>
  untitled: () => string
  category: () => string
}) {
  let abort: AbortController | undefined

  onCleanup(() => abort?.abort())

  return async (text: string): Promise<CommandPaletteEntry[]> => {
    const search = text.trim()
    if (!search) {
      abort?.abort()
      return []
    }
    abort?.abort()
    const current = new AbortController()
    abort = current
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100)
      current.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    if (current.signal.aborted) return []
    const opened = props.opened()
    const openedByID = new Map(opened.flatMap((project) => (project.id ? [[project.id, project] as const] : [])))
    const stored = props.stored().map((project) => ({ ...project, expanded: false }))
    const storedByID = new Map(stored.map((project) => [project.id, project] as const))
    return props
      .load(search, current.signal)
      .then((result) =>
        result.data
          .map(normalizeSessionInfo)
          .filter((session) => !session.time.archived)
          .map((session) => {
            const project =
              projectForSession(session, opened, openedByID) ?? projectForSession(session, stored, storedByID)
            return {
              id: `session:${props.server}:${session.id}`,
              type: "session" as const,
              title: session.title || props.untitled(),
              description: project ? displayName(project) : getFilename(session.directory),
              category: props.category(),
              directory: session.directory,
              sessionID: session.id,
              server: props.server,
              project,
              updated: session.time.updated,
            }
          }),
      )
      .catch(() => [] as CommandPaletteEntry[])
  }
}
