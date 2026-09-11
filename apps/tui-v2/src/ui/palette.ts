import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import type { Client, ThreadView } from "../client/model"
import { scenarios } from "../client/model"
import type { PaletteEntry } from "./overlays"
import type { Overlay } from "./types"

interface PaletteOptions {
  readonly isOpen: Accessor<boolean>
  readonly client: Client
  readonly selectedThread: Accessor<ThreadView | undefined>
  readonly newThread: (target: ThreadView["target"]) => void
  readonly openThreadSwitcher: () => void
  readonly openModePicker: () => void
  readonly setOverlay: (overlay: Overlay) => void
  readonly toggleSidebar: (kind: "workspace" | "changed") => void
  readonly editPending: (id: string) => void
  readonly closeOverlay: () => void
}

export function createPalette(options: PaletteOptions) {
  const {
    client,
    selectedThread,
    newThread,
    openThreadSwitcher,
    openModePicker,
    setOverlay,
    toggleSidebar,
    editPending,
    closeOverlay,
  } = options
  const [paletteQuery, setPaletteQuery] = createSignal("")
  const [paletteIndex, setPaletteIndex] = createSignal(0)
  const paletteEntries = createMemo<readonly PaletteEntry[]>(() => {
    if (!options.isOpen()) return []
    const entries: PaletteEntry[] = [
      { id: "new-thread", label: "New Thread", detail: "Ctrl+N", run: () => newThread("runner") },
      { id: "new-box-thread", label: "New Thread in a Box", detail: "Ctrl+Shift+N", run: () => newThread("orb") },
      { id: "switch-thread", label: "Switch Thread", detail: "Ctrl+T", run: () => openThreadSwitcher() },
      { id: "mode", label: "Change mode", detail: "Ctrl+S", run: openModePicker },
      { id: "context", label: "Show context and usage", detail: "Ctrl+Y", run: () => setOverlay("context") },
      { id: "workspace-files", label: "Toggle file tree", detail: "Alt+T", run: () => toggleSidebar("workspace") },
      { id: "changed-files", label: "Toggle changed files", detail: "Alt+S", run: () => toggleSidebar("changed") },
      { id: "shortcuts", label: "Show shortcuts", detail: "?", run: () => setOverlay("shortcuts") },
      { id: "cancel", label: "Cancel current run", detail: "Ctrl+C", run: () => client.cancel() },
      { id: "stop", label: "Stop current Session", detail: "", run: () => client.stop() },
      { id: "quit", label: "Quit", detail: "Ctrl+C", run: () => setOverlay("exit") },
    ]
    if (selectedThread()?.approval != null) {
      entries.push(
        { id: "approve", label: "Approve operation", detail: "A", run: () => client.approve(true) },
        { id: "deny", label: "Deny operation", detail: "D", run: () => client.approve(false) },
      )
    }
    for (const pending of selectedThread()?.pending ?? []) {
      entries.push(
        {
          id: `edit:${pending.id}`,
          label: `Edit pending: ${pending.prompt}`,
          detail: "Ctrl+E",
          run: () => editPending(pending.id),
        },
        {
          id: `remove:${pending.id}`,
          label: `Remove pending: ${pending.prompt}`,
          detail: "Backspace",
          run: () => client.removePending(pending.id),
        },
        {
          id: `steer:${pending.id}`,
          label: `Steer pending: ${pending.prompt}`,
          detail: "Enter",
          run: () => client.steerPending(pending.id),
        },
      )
    }
    for (const [index, scenario] of scenarios.entries())
      entries.push({
        id: scenario.id,
        label: `Scenario: ${scenario.title}`,
        detail: `Ctrl+${index + 1}`,
        run: () => client.loadScenario(scenario.id),
      })
    const query = paletteQuery().trim().toLowerCase()
    return query.length === 0
      ? entries
      : entries.filter((entry) => `${entry.label} ${entry.detail}`.toLowerCase().includes(query))
  })
  createEffect(() => setPaletteIndex((index) => Math.min(index, Math.max(0, paletteEntries().length - 1))))
  const choosePalette = () => {
    const entry = paletteEntries()[paletteIndex()]
    closeOverlay()
    entry?.run()
  }
  const choosePaletteEntry = (entry: PaletteEntry | undefined) => {
    closeOverlay()
    entry?.run()
  }
  return {
    paletteEntries,
    paletteQuery,
    setPaletteQuery,
    paletteIndex,
    setPaletteIndex,
    choosePalette,
    choosePaletteEntry,
  }
}
