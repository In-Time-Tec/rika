export const threadTitleLimit = 80

export const clampThreadTitle = (text: string): string =>
  [
    ...text
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, threadTitleLimit)
    .join("")
    .trimEnd()
