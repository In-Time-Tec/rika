import { describe, expect, test } from "vitest"
import { packageEntries, validatePackageArchive } from "../../scripts/archive-contract"

const root = "rika-1.2.3-linux-x64"
const entries = packageEntries(root)
const names = entries.map((entry) => entry.name).join("\n") + "\n"
const headers = entries
  .map(
    (entry) =>
      `${entry.type}${entry.executable ? "rwxr-xr-x" : "rw-r--r--"} user/group 1 2026-07-22 00:00 ${entry.name}`,
  )
  .join("\n")

describe("package archive contract", () => {
  test("accepts the exact regular-file package with executable binaries", () => {
    expect(() => validatePackageArchive(root, names, headers)).not.toThrow()
  })

  test.each([
    ["missing performance runtime", names.replace(`${root}/bin/.rika-performance\n`, ""), headers],
    ["missing interactive binary", names.replace(`${root}/bin/.rika-interactive\n`, ""), headers],
    ["missing resident binary", names.replace(`${root}/bin/.rika-resident\n`, ""), headers],
    [
      "duplicate entry",
      names + `${root}/bin/rika\n`,
      headers + `\n-rwxr-xr-x user/group 1 2026-07-22 00:00 ${root}/bin/rika`,
    ],
    [
      "extra entry",
      names + `${root}/node_modules\n`,
      headers + `\n-rw-r--r-- user/group 1 2026-07-22 00:00 ${root}/node_modules`,
    ],
    ["symlink executable", names, headers.replace("-rwxr-xr-x", "lrwxrwxrwx")],
    ["non-executable runtime", names, headers.replace("-rwxr-xr-x", "-rw-r--r--")],
    ["group-only executable runtime", names, headers.replace("-rwxr-xr-x", "-rw-r-xr--")],
    ["traversal", names.replace(`${root}/INSTALL`, `${root}/../INSTALL`), headers],
    ["absolute path", names.replace(`${root}/INSTALL`, "/tmp/INSTALL"), headers],
  ])("rejects %s", (_case, candidateNames, candidateHeaders) => {
    expect(() => validatePackageArchive(root, candidateNames, candidateHeaders)).toThrow()
  })
})
