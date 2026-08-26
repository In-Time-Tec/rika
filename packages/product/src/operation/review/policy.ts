import type { ReviewIntent } from "../../execution/review-intent"

const lanePrompt = (lane: string, focus: string, request: string) =>
  `Review the request from the ${lane} lane. ${focus}\n\nRequest:\n${request}`

export const reviewIntent = (request: string): ReviewIntent => ({
  _tag: "Review",
  lanes: [
    {
      key: "correctness",
      prompt: lanePrompt(
        "correctness",
        "Find behavioral defects, regressions, invalid assumptions, and missing acceptance coverage.",
        request,
      ),
    },
    {
      key: "security",
      prompt: lanePrompt(
        "security",
        "Find authority leaks, unsafe inputs, sensitive-data exposure, and denial-of-service risks.",
        request,
      ),
    },
    {
      key: "quality",
      prompt: lanePrompt(
        "quality",
        "Find maintainability, boundary, reliability, and verification problems that affect production use.",
        request,
      ),
    },
  ],
  concurrency: 3,
  completion: "wait-for-all",
})

export const reviewRouteMode = (mode: string): string => `review:${mode}`

export const isReviewRouteMode = (mode: string): boolean => mode.startsWith("review:")
