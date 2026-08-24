import { Function } from "effect"
export interface ViewportMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly viewportHeight: number
}

export const maxScrollTop = (metrics: ViewportMetrics): number =>
  Math.max(0, metrics.scrollHeight - metrics.viewportHeight)
export const atBottomWithin: {
  (tolerance: number): (metrics: ViewportMetrics) => boolean
  (metrics: ViewportMetrics, tolerance: number): boolean
} = Function.dual(
  2,
  (metrics: ViewportMetrics, tolerance: number): boolean => metrics.scrollTop >= maxScrollTop(metrics) - tolerance,
)
export const atBottom = (metrics: ViewportMetrics): boolean => atBottomWithin(metrics, 0)
