import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mountPierreTree } from "../src/pierre-tree"

describe("Pierre tree adapter", () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://localhost:3000", width: 1280, height: 720 })
    if (globalThis.ResizeObserver === undefined) globalThis.ResizeObserver = NoopResizeObserver
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  test("mounts, updates, focuses, and destroys a reusable tree container", () => {
    const container = document.createElement("div")
    const selected: Array<string> = []
    document.body.append(container)

    const handle = mountPierreTree({
      container,
      paths: ["src/", "src/index.ts"],
      selected_path: "src/index.ts",
      git_status: [{ path: "src/index.ts", status: "modified" }],
      onSelectedPath: (path) => selected.push(path),
    })

    try {
      expect(container.firstElementChild?.tagName).toBe("FILE-TREE-CONTAINER")
      expect(treeItem(container, "src/index.ts")?.getAttribute("aria-selected")).toBe("true")

      handle.update({ paths: ["src/", "src/index.ts", "src/new.ts"], selected_path: "src/new.ts" })
      handle.focus("src/new.ts")

      expect(treeItem(container, "src/new.ts")).not.toBeNull()
      expect(treeItem(container, "src/new.ts")?.getAttribute("aria-selected")).toBe("true")
      expect(treeItem(container, "src/index.ts")?.getAttribute("aria-selected")).toBe("false")

      handle.update({ paths: ["src/", "src/index.ts", "src/new.ts"] })

      expect(treeItem(container, "src/new.ts")?.getAttribute("aria-selected")).toBe("false")
      expect(selected).toEqual([])
    } finally {
      handle.destroy()
    }

    expect(container.childElementCount).toBe(0)

    const next = mountPierreTree({ container, paths: ["README.md"], onSelectedPath: () => {} })
    try {
      expect(treeItem(container, "README.md")).not.toBeNull()
    } finally {
      next.destroy()
    }
  })

  test("updates paths in place and preserves collapsed directories", async () => {
    const container = document.createElement("div")
    document.body.append(container)

    const handle = mountPierreTree({
      container,
      paths: ["src/", "src/index.ts", "src/nested/", "src/nested/file.ts"],
      onSelectedPath: () => undefined,
    })

    try {
      const host = container.firstElementChild
      expect(host?.tagName).toBe("FILE-TREE-CONTAINER")
      expect(treeItem(container, "src/nested/")?.getAttribute("aria-expanded")).toBe("true")

      treeItem(container, "src/nested/")?.click()
      await Bun.sleep(0)

      expect(treeItem(container, "src/nested/")?.getAttribute("aria-expanded")).toBe("false")

      handle.update({
        paths: ["src/", "src/index.ts", "src/new.ts", "src/nested/", "src/nested/file.ts"],
        selected_path: "src/new.ts",
      })

      expect(container.firstElementChild).toBe(host)
      expect(treeItem(container, "src/nested/")?.getAttribute("aria-expanded")).toBe("false")
      expect(treeItem(container, "src/new.ts")?.getAttribute("aria-selected")).toBe("true")
    } finally {
      handle.destroy()
    }
  })

  test("updates git status markers", () => {
    const container = document.createElement("div")
    document.body.append(container)

    const handle = mountPierreTree({
      container,
      paths: ["src/", "src/index.ts"],
      onSelectedPath: () => undefined,
    })

    try {
      expect(treeItem(container, "src/index.ts")?.getAttribute("data-item-git-status")).toBeNull()

      handle.update({
        paths: ["src/", "src/index.ts"],
        git_status: [{ path: "src/index.ts", status: "modified" }],
      })

      expect(treeItem(container, "src/index.ts")?.getAttribute("data-item-git-status")).toBe("modified")
    } finally {
      handle.destroy()
    }
  })

  test("reports canonical selected paths from user selection", () => {
    const container = document.createElement("div")
    const selected: Array<string> = []
    document.body.append(container)

    const handle = mountPierreTree({
      container,
      paths: ["src/", "src/index.ts", "README.md"],
      onSelectedPath: (path) => selected.push(path),
    })

    try {
      treeItem(container, "src/index.ts")?.click()

      expect(selected).toEqual(["src/index.ts"])
    } finally {
      handle.destroy()
    }
  })

  test("reports the additive user selection after a programmatic selection update", () => {
    const container = document.createElement("div")
    const selected: Array<string> = []
    document.body.append(container)

    const handle = mountPierreTree({
      container,
      paths: ["src/", "src/index.ts", "src/new.ts"],
      selected_path: "src/index.ts",
      onSelectedPath: (path) => selected.push(path),
    })

    try {
      handle.update({ paths: ["src/", "src/index.ts", "src/new.ts"], selected_path: "src/new.ts" })
      treeItem(container, "src/index.ts")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true, ctrlKey: true }),
      )

      expect(selected).toEqual(["src/index.ts"])
    } finally {
      handle.destroy()
    }
  })

  test("does not report preserved user multi-selection during a programmatic path update", () => {
    const container = document.createElement("div")
    const selected: Array<string> = []
    document.body.append(container)

    const handle = mountPierreTree({
      container,
      paths: ["a.ts", "b.ts"],
      onSelectedPath: (path) => selected.push(path),
    })

    try {
      treeItem(container, "a.ts")?.click()
      treeItem(container, "b.ts")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true, ctrlKey: true }),
      )

      selected.length = 0
      handle.update({ paths: ["a.ts"] })

      expect(selected).toEqual([])
    } finally {
      handle.destroy()
    }
  })
})

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const treeItem = (container: HTMLElement, path: string): HTMLElement | null =>
  container.firstElementChild?.shadowRoot?.querySelector(`[role="treeitem"][data-item-path="${path}"]`) ?? null
