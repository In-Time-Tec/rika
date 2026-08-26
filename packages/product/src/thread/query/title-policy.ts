export const threadTitleLimit = 80

export const clampThreadTitle = (text: string): string =>
  [
    ...text
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, threadTitleLimit)
    .join("")
    .trimEnd()
