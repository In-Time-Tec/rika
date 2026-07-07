import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const appRoot = new URL("..", import.meta.url)

describe("FoldCN provenance", () => {
  test("pins the initialized app and reviewed local UI source", () => {
    const components = readJson("components.json")
    const lock = readJson("foldcn.lock.json")

    expect(isComponentsConfig(components)).toBe(true)
    expect(isFoldcnLock(lock)).toBe(true)
    if (!isComponentsConfig(components)) throw new Error("invalid components.json")
    if (!isFoldcnLock(lock)) throw new Error("invalid foldcn.lock.json")

    expect(components.css).toBe("src/styles.css")
    expect(components.baseColor).toBe("neutral")
    expect(components.aliases).toEqual({ ui: "src/components/ui", lib: "src/lib" })
    expect(lock.foldcn.version).toBe("0.0.21")
    expect(lock.foldcn.sha256).toBe("2bc3564beb0f482d775b4a796c65220383272bc7af8733e2685aa6e1c8091c32")
    expect(lock.registry.default_url).toBe("https://foldcn.dev/r/{name}.json")
    expect(lock.registry.status).toBe("dns-unresolved")
    expect(lock.local_registry.ui_path).toBe("/Users/dallen.pyrah/projects/foldcn/apps/www/registry/ui")
    expect(lock.local_registry.styles_path).toBe(
      "/Users/dallen.pyrah/projects/foldcn/apps/www/registry/styles/globals.css",
    )
    expect(lock.foldkit_ui.version).toBe("0.120.0")
    expect(lock.foldkit_ui.sha256).toBe("ac18e65434263473f1fce736f33e7289780af7490522c3bc221e19857dbc372d")
    expect(lock.components.map((component) => component.name)).toEqual([
      "cn",
      "types",
      "button",
      "textarea",
      "tabs-state",
      "tabs",
      "select",
      "badge",
      "card",
      "avatar",
      "message",
      "bubble",
      "code-block",
      "spinner",
      "message-scroller-state",
      "message-scroller",
      "conversation",
      "prompt-input",
      "chain-of-thought",
      "reasoning",
      "tool",
      "alert-dialog",
    ])
    for (const component of lock.components) {
      expect(component.source).toBeTruthy()
      expect(sha256(component.path)).toBe(component.sha256)
    }
  })
})

interface ComponentsConfig {
  readonly css: string
  readonly baseColor: string
  readonly aliases: Readonly<Record<string, string>>
}

interface FoldcnLock {
  readonly foldcn: {
    readonly version: string
    readonly sha256: string
  }
  readonly registry: {
    readonly default_url: string
    readonly status: string
  }
  readonly local_registry: {
    readonly ui_path: string
    readonly styles_path: string
  }
  readonly foldkit_ui: {
    readonly version: string
    readonly sha256: string
  }
  readonly components: ReadonlyArray<{
    readonly name: string
    readonly path: string
    readonly source: string
    readonly sha256: string
  }>
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, appRoot), "utf8"))

const sha256 = (path: string): string =>
  createHash("sha256")
    .update(readFileSync(join(appRoot.pathname, path)))
    .digest("hex")

const isComponentsConfig = (value: unknown): value is ComponentsConfig =>
  isRecord(value) &&
  typeof value.css === "string" &&
  typeof value.baseColor === "string" &&
  isStringRecord(value.aliases)

const isFoldcnLock = (value: unknown): value is FoldcnLock =>
  isRecord(value) &&
  isVersionLock(value.foldcn) &&
  isRecord(value.registry) &&
  typeof value.registry.default_url === "string" &&
  typeof value.registry.status === "string" &&
  isRecord(value.local_registry) &&
  typeof value.local_registry.ui_path === "string" &&
  typeof value.local_registry.styles_path === "string" &&
  isVersionLock(value.foldkit_ui) &&
  Array.isArray(value.components) &&
  value.components.every(isComponentLock)

const isVersionLock = (value: unknown): value is { readonly version: string; readonly sha256: string } =>
  isRecord(value) && typeof value.version === "string" && typeof value.sha256 === "string"

const isComponentLock = (
  value: unknown,
): value is { readonly name: string; readonly path: string; readonly source: string; readonly sha256: string } =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.path === "string" &&
  typeof value.source === "string" &&
  typeof value.sha256 === "string"

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === "string")

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
