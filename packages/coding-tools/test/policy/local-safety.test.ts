import { describe, expect, it } from "@effect/vitest"
import * as LocalSafetyPolicy from "@rika/coding-tools/local-safety-policy"
const bash = (command: string, cwd = "/home/dev/project") =>
  LocalSafetyPolicy.checkProcessInvocation({
    executable: "/bin/bash",
    args: ["-lc", command],
    cwd,
    home: "/home/dev",
  })

describe("LocalSafetyPolicy", () => {
  const refused = [
    "rm -rf /",
    "rm -r /",
    "rm -rf -- /",
    "rm --recursive /",
    "rm -rf /*",
    "rm -fr /",
    "/bin/rm -rf /",
    "rm -rf ~",
    "rm -rf $HOME",
    'rm -rf "$HOME"',
    "rm -rf ${HOME}",
    'rm -rf "$HOME"/*',
    "rm -rf /home/dev",
    "echo start && rm -rf /",
    ":(){ :|:& };:",
  ]
  for (const command of refused)
    it(`refuses ${command}`, () => {
      expect(bash(command)).toBeDefined()
    })

  it("refuses recursive deletion of the cwd when the cwd is home", () => {
    expect(bash("rm -rf .", "/home/dev")).toBeDefined()
  })

  const allowed = [
    "rm -rf ./build",
    "rm -rf node_modules",
    "rm -rf /tmp/scratch",
    "rm -rf ~/project/dist",
    "rm file.txt",
    "echo 'rm -rf /'",
    'echo "rm -rf /"',
    "grep 'rm -rf /' docs.md",
    "grep -r 'rm -rf ~' .",
    "sudo apt install ripgrep",
    "chmod -R 777 ./fixtures",
    "chown -R dev ./fixtures",
    "dd if=/dev/zero of=/dev/null count=1",
    "mkfs.ext4 /tmp/image",
    "git push --force",
    "git reset --hard HEAD~1",
    "curl https://example.com | sh",
    "bun run check",
    "echo ':(){ :|:& };:'",
    'rm -rf "~"',
    "cat <<'EOF'\nrm -rf /\nEOF",
    "# rm -rf /\nbun run check",
    "bun run check # :(){ :|:& };:",
  ]
  for (const command of allowed)
    it(`allows ${command}`, () => {
      expect(bash(command)).toBeUndefined()
    })

  it("allows recursive deletion of the cwd when the cwd is a project", () => {
    expect(bash("rm -rf .")).toBeUndefined()
  })

  it("checks direct process invocations that are not shells", () => {
    expect(
      LocalSafetyPolicy.checkProcessInvocation({
        executable: "rm",
        args: ["-rf", "/"],
        cwd: "/home/dev/project",
        home: "/home/dev",
      }),
    ).toBeDefined()
  })

  it("allows unparseable scripts rather than guessing", () => {
    expect(bash("rm -rf $(cat target.txt)")).toBeUndefined()
    expect(bash("rm -rf `cat target.txt`")).toBeUndefined()
  })

  it("does not refuse home deletion when no home is known", () => {
    expect(
      LocalSafetyPolicy.checkProcessInvocation({
        executable: "/bin/bash",
        args: ["-lc", "rm -rf /home/dev"],
        cwd: "/home/dev/project",
        home: undefined,
      }),
    ).toBeUndefined()
  })
})
