export const threadTitleLimit = 80

export const clampThreadTitle = (text: string): string => [...text].slice(0, threadTitleLimit).join("")
