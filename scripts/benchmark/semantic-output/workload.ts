import type { Case } from "./contract"

export const outputBytes = 1_000_000
export const outputSha256 = new Bun.CryptoHasher("sha256").update("x".repeat(outputBytes)).digest("hex")

export const fragments = (name: Case): ReadonlyArray<string> => {
  if (name === "one") return ["x".repeat(outputBytes)]
  if (name === "ten-thousand") return Array.from({ length: 10_000 }, () => "x".repeat(100))
  return Array.from({ length: 10_000 }, (_, index) => (index % 2 === 0 ? "" : "x".repeat(200)))
}

export const describe = (name: Case) => {
  const values = fragments(name)
  const text = values.join("")
  return {
    name,
    fragments: values.length,
    nonemptyFragments: values.filter((fragment) => fragment.length > 0).length,
    fragmentBytes: values.map((fragment) => Buffer.byteLength(fragment)),
    outputBytes: Buffer.byteLength(text),
    outputSha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
  }
}
