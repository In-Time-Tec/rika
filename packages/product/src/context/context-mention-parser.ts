export interface Mentions {
  readonly files: ReadonlyArray<string>
  readonly references: ReadonlyArray<string>
  readonly images: ReadonlyArray<string>
}

const values = (text: string, kind: string) =>
  [...text.matchAll(new RegExp(`(?:^|\\s)@${kind}:((?:"[^"]+")|(?:'[^']+')|[^\\s,;]+)`, "g"))]
    .map((match) => match[1]!.replace(/^(["'])|(["'])$/g, ""))
    .filter((value) => value.length > 0)

const unique = (input: ReadonlyArray<string>) => [...new Set(input)].toSorted()

export const parse = (text: string): Mentions => ({
  files: unique(values(text, "file")),
  references: unique(values(text, "(?:ref|guidance)")),
  images: unique(values(text, "image")),
})
