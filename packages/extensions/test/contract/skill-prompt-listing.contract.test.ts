import { expect, it } from "vitest"
import * as SkillPromptListing from "@rika/extensions/skill-prompt-listing"
import type * as SkillRegistryModel from "@rika/extensions/skill-registry-model"

const executable = (
  name: string,
  overrides?: Partial<SkillRegistryModel.Executable>,
): SkillRegistryModel.Executable => ({
  name,
  importName: `@skills/${name}`,
  digest: "digest",
  origin: "global",
  importable: true,
  ...overrides,
})

it("returns nothing when no skill is discovered", () => {
  expect(SkillPromptListing.format({ listings: [], executable: [] })).toBe("")
})

it("carries listings only, never bodies", () => {
  const text = SkillPromptListing.format({
    listings: ["- review: reviews code", "- notes: takes notes"],
    executable: [],
  })
  expect(text).toBe("## Skills\n- review: reviews code\n- notes: takes notes")
})

it("names the import of every importable executable skill", () => {
  const text = SkillPromptListing.format({
    listings: ["- search: searches"],
    executable: [executable("search", { importName: "rika-search" })],
  })
  expect(text).toContain("## Executable skills")
  expect(text).toContain('- search: import from "rika-search"')
})

it("lists an untrusted executable skill without offering an import", () => {
  const text = SkillPromptListing.format({
    listings: ["- local: local"],
    executable: [executable("local", { origin: "workspace", importable: false })],
  })
  expect(text).toContain("## Untrusted executable skills")
  expect(text).toContain("- local")
  expect(text).not.toContain("import from")
})

it("bounds the number of listed skills and reports the remainder", () => {
  const listings = Array.from({ length: 10 }, (_, index) => `- skill${index}: description`)
  const text = SkillPromptListing.format({ listings, executable: [] }, { maxSkills: 3 })
  expect(text.split("\n")).toEqual([
    "## Skills",
    "- skill0: description",
    "- skill1: description",
    "- skill2: description",
    "- (7 more not listed)",
  ])
})

it("bounds one listing line", () => {
  const text = SkillPromptListing.format(
    { listings: [`- long: ${"x".repeat(500)}`], executable: [] },
    { maxLineLength: 20 },
  )
  const line = text.split("\n")[1]
  expect(line).toHaveLength(20)
  expect(line?.endsWith("…")).toBe(true)
})

it("produces output whose size depends only on the bounds", () => {
  const small = SkillPromptListing.format(
    { listings: ["- a: a"], executable: [executable("a")] },
    { maxSkills: 2, maxLineLength: 40 },
  )
  const large = SkillPromptListing.format(
    {
      listings: Array.from({ length: 200 }, (_, index) => `- s${index}: ${"y".repeat(300)}`),
      executable: Array.from({ length: 200 }, (_, index) => executable(`s${index}`)),
    },
    { maxSkills: 2, maxLineLength: 40 },
  )
  expect(small.split("\n").length).toBeLessThanOrEqual(12)
  expect(large.split("\n").length).toBeLessThanOrEqual(12)
  expect(large.split("\n").every((line) => line.length <= 40)).toBe(true)
})
