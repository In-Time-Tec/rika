import { describe, expect, test } from "vitest"
import { packageEntries, validatePackageArchive } from "../../scripts/packaging/archive-contract"

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
  test("accepts exactly INSTALL and one executable", () => {
    expect(entries.map(({ name }) => name)).toEqual([`${root}/`, `${root}/INSTALL`, `${root}/bin/`, `${root}/bin/rika`])
    expect(() => validatePackageArchive(root, names, headers)).not.toThrow()
  })

  test.each([
    ["missing executable", names.replace(`${root}/bin/rika\n`, ""), headers],
    [
      "private runtime",
      names + `${root}/bin/.rika-performance\n`,
      headers + `\n-rwxr-xr-x user/group 1 2026-07-22 00:00 ${root}/bin/.rika-performance`,
    ],
    [
      "kernel helper",
      names + `${root}/bin/.rika-kernel-runtime\n`,
      headers + `\n-rwxr-xr-x user/group 1 2026-07-22 00:00 ${root}/bin/.rika-kernel-runtime`,
    ],
    [
      "server sidecar",
      names + `${root}/bin/.rika-server\n`,
      headers + `\n-rwxr-xr-x user/group 1 2026-07-22 00:00 ${root}/bin/.rika-server`,
    ],
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
    ["non-executable binary", names, headers.replace("-rwxr-xr-x", "-rw-r--r--")],
    ["traversal", names.replace(`${root}/INSTALL`, `${root}/../INSTALL`), headers],
    ["absolute path", names.replace(`${root}/INSTALL`, "/tmp/INSTALL"), headers],
  ])("rejects %s", (_case, candidateNames, candidateHeaders) => {
    expect(() => validatePackageArchive(root, candidateNames, candidateHeaders)).toThrow()
  })
})
