export const terminalSafeText = (text: string): string =>
  text.replaceAll("\r\n", "\n").replace(/\p{Cc}/gu, (character) => (character === "\n" ? character : "�"))
