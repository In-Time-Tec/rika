import { Function } from "effect"

export interface AnchorCandidate {
  readonly key: string
  readonly screenY: number
  readonly height: number
}

export interface CapturedAnchor {
  readonly key: string
  readonly screenY: number
}

const topmostVisibleAnchorImpl = (
  candidates: ReadonlyArray<AnchorCandidate>,
  geometry: { readonly viewportTop: number; readonly drift: number },
): CapturedAnchor | undefined => {
  const first = candidates
    .filter(
      (candidate) =>
        candidate.height > 0 && candidate.screenY + geometry.drift + candidate.height > geometry.viewportTop,
    )
    .toSorted((left, right) => left.screenY - right.screenY)[0]
  return first === undefined ? undefined : { key: first.key, screenY: first.screenY + geometry.drift }
}

export const topmostVisibleAnchor: {
  (
    arg0: Parameters<typeof topmostVisibleAnchorImpl>[0],
    arg1: Parameters<typeof topmostVisibleAnchorImpl>[1],
  ): ReturnType<typeof topmostVisibleAnchorImpl>
  (
    arg1: Parameters<typeof topmostVisibleAnchorImpl>[1],
  ): (arg0: Parameters<typeof topmostVisibleAnchorImpl>[0]) => ReturnType<typeof topmostVisibleAnchorImpl>
} = Function.dual(2, topmostVisibleAnchorImpl)
