import {
  FileTree,
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
  type FileTreeOptions,
  type GitStatusEntry,
} from "@pierre/trees"
import { Context, Effect, HashMap, Layer, Option, Ref } from "effect"

export interface PierreTreeInput {
  readonly paths: ReadonlyArray<string>
  readonly selected_path?: string
  readonly git_status?: ReadonlyArray<GitStatusEntry>
}

export interface PierreTreeMountInput extends PierreTreeInput {
  readonly container: HTMLElement
  readonly onSelectedPath: (path: string) => void
}

export interface PierreTreeHandle {
  readonly update: (input: PierreTreeInput) => void
  readonly focus: (path: string) => void
  readonly destroy: () => void
}

export interface PierreTreeRegistryInterface {
  readonly register: (key: string, handle: PierreTreeHandle) => Effect.Effect<void>
  readonly unregister: (key: string, handle: PierreTreeHandle) => Effect.Effect<void>
  readonly update: (key: string, input: PierreTreeInput) => Effect.Effect<boolean>
}

export class PierreTreeRegistry extends Context.Service<PierreTreeRegistry, PierreTreeRegistryInterface>()(
  "@rika/web/PierreTreeRegistry",
) {}

type PierreTreeHandles = HashMap.HashMap<string, PierreTreeHandle>

const makePierreTreeRegistry = (handles: Ref.Ref<PierreTreeHandles>): PierreTreeRegistryInterface => {
  const register: PierreTreeRegistryInterface["register"] = Effect.fn("PierreTreeRegistry.register")(
    (key: string, handle: PierreTreeHandle) => Ref.update(handles, (current) => HashMap.set(current, key, handle)),
  )
  const unregister: PierreTreeRegistryInterface["unregister"] = Effect.fn("PierreTreeRegistry.unregister")(
    (key: string, handle: PierreTreeHandle) =>
      Ref.update(handles, (current) =>
        Option.match(HashMap.get(current, key), {
          onNone: () => current,
          onSome: (currentHandle) => (currentHandle === handle ? HashMap.remove(current, key) : current),
        }),
      ),
  )
  const update: PierreTreeRegistryInterface["update"] = Effect.fn("PierreTreeRegistry.update")(function* (
    key: string,
    input: PierreTreeInput,
  ) {
    const current = yield* Ref.get(handles)
    const handle = Option.getOrUndefined(HashMap.get(current, key))
    if (handle === undefined) return false
    yield* Effect.sync(() => handle.update(input))
    return true
  })
  return { register, unregister, update }
}

const pierreTreeHandles: Ref.Ref<PierreTreeHandles> = Ref.makeUnsafe(HashMap.empty())

export const pierreTreeRegistry = makePierreTreeRegistry(pierreTreeHandles)

export const pierreTreeRegistryLayer = Layer.succeed(PierreTreeRegistry, PierreTreeRegistry.of(pierreTreeRegistry))

export const updatePierreTree = Effect.fn("PierreTreeRegistry.update.call")(function* (
  key: string,
  input: PierreTreeInput,
) {
  return yield* pierreTreeRegistry.update(key, input)
})

export const mountPierreTree = (input: PierreTreeMountInput): PierreTreeHandle => {
  let suppressSelection = false
  const options: FileTreeOptions = {
    paths: input.paths,
    initialExpansion: "closed",
    initialExpandedPaths: directoryPaths(input.paths),
    search: true,
    initialSelectedPaths: input.selected_path === undefined ? [] : [input.selected_path],
    onSelectionChange: (selectedPaths) => {
      if (suppressSelection) return
      const path = selectedPaths[selectedPaths.length - 1]
      if (path === undefined) return
      input.onSelectedPath(path)
    },
    ...(input.git_status === undefined ? {} : { gitStatus: input.git_status }),
  }
  const tree = new FileTree(options)
  tree.render({ containerWrapper: input.container })
  return {
    update: (next) => {
      suppressSelection = true
      try {
        tree.resetPaths(next.paths, { initialExpandedPaths: expandedDirectoryPaths(tree, next.paths) })
        tree.setGitStatus(next.git_status)
        for (const path of tree.getSelectedPaths()) tree.getItem(path)?.deselect()
        if (next.selected_path !== undefined) tree.getItem(next.selected_path)?.select()
      } finally {
        suppressSelection = false
      }
      tree.render({ containerWrapper: input.container })
    },
    focus: (path) => tree.scrollToPath(path, { focus: true }),
    destroy: () => {
      try {
        tree.cleanUp()
      } finally {
        input.container.replaceChildren()
      }
    },
  }
}

const expandedDirectoryPaths = (tree: FileTree, paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.filter((path) => {
    if (!path.endsWith("/")) return false
    const item = tree.getItem(path)
    return isDirectoryHandle(item) && item.isExpanded()
  })

const directoryPaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.filter((path) => path.endsWith("/"))

const isDirectoryHandle = (item: FileTreeItemHandle | null): item is FileTreeDirectoryHandle =>
  item?.isDirectory() === true
