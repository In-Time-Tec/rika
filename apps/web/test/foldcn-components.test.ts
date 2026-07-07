import { describe, test } from "bun:test"
import type { Html } from "foldkit/html"

Object.assign(globalThis, {
  window: {
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  },
})

const [{ html }, Scene, Button, Card] = await Promise.all([
  import("foldkit/html"),
  import("foldkit/scene"),
  import("../src/components/ui/button"),
  import("../src/components/ui/card"),
])

const H = html()

const update = (model: number, _message: never): readonly [number, ReadonlyArray<never>] => [model, []]

describe("foldcn component contracts", () => {
  test("card uses SlotConfig class with tailwind-merge override semantics", () => {
    const view = (): Html =>
      Card.card<never>({ attributes: [H.Class("bg-destructive")], class: "bg-muted rounded-sm" }, ["Card"])

    Scene.scene(
      { update, view },
      Scene.with(0),
      Scene.expect(Scene.selector('[data-slot="card"]')).toHaveClass("bg-muted"),
      Scene.expect(Scene.selector('[data-slot="card"]')).toHaveClass("rounded-sm"),
      Scene.expect(Scene.selector('[data-slot="card"]')).not.toHaveClass("bg-card"),
      Scene.expect(Scene.selector('[data-slot="card"]')).not.toHaveClass("bg-destructive"),
      Scene.expect(Scene.selector('[data-slot="card"]')).not.toHaveClass("rounded-xl"),
    )
  })

  test("button places its component class after attributes", () => {
    const view = (): Html =>
      Button.button<never>({ attributes: [H.Class("h-20 bg-destructive")], class: "h-8 bg-secondary" }, ["Button"])

    Scene.scene(
      { update, view },
      Scene.with(0),
      Scene.expect(Scene.role("button", { name: "Button" })).toHaveClass("h-8"),
      Scene.expect(Scene.role("button", { name: "Button" })).toHaveClass("bg-secondary"),
      Scene.expect(Scene.role("button", { name: "Button" })).not.toHaveClass("h-20"),
      Scene.expect(Scene.role("button", { name: "Button" })).not.toHaveClass("bg-destructive"),
    )
  })
})
