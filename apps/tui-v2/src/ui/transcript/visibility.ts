import type { ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { createContext, useContext, type Accessor } from "solid-js"

export const AnimationViewport = createContext<Accessor<ScrollBoxRenderable | undefined>>()

export const createVisibleFrame = (frame: Accessor<number>) => {
  const viewport = useContext(AnimationViewport)
  let header: TextRenderable | undefined
  return {
    ref: (node: TextRenderable) => {
      header = node
    },
    frame: () => {
      const value = frame()
      const scroll = viewport?.()
      if (scroll === undefined || header === undefined) return value
      const top = scroll.viewport.y
      return header.y + header.height > top && header.y < top + scroll.viewport.height ? value : 0
    },
  }
}
