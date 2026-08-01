import { Function } from "effect"
const nonSpaceBoundsImpl = (frame: string, height: number) => {
  const points = frame
    .split("\n")
    .slice(0, height - 5)
    .flatMap((row, y) => Array.from(row, (cell, x) => ({ cell, x, y })))
    .filter(({ cell }) => cell !== " ")
  return {
    left: Math.min(...points.map(({ x }) => x)),
    right: Math.max(...points.map(({ x }) => x)),
    top: Math.min(...points.map(({ y }) => y)),
    bottom: Math.max(...points.map(({ y }) => y)),
  }
}

export const nonSpaceBounds: {
  (
    arg1: Parameters<typeof nonSpaceBoundsImpl>[1],
  ): (arg0: Parameters<typeof nonSpaceBoundsImpl>[0]) => ReturnType<typeof nonSpaceBoundsImpl>
  (
    arg0: Parameters<typeof nonSpaceBoundsImpl>[0],
    arg1: Parameters<typeof nonSpaceBoundsImpl>[1],
  ): ReturnType<typeof nonSpaceBoundsImpl>
} = Function.dual(2, nonSpaceBoundsImpl)
