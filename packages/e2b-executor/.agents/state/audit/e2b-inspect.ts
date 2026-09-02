import { Sandbox } from "e2b"
const id = process.argv[2]!
const sandbox = await Sandbox.connect(id)
const run = async (cmd: string) => {
  const r = await sandbox.commands
    .run(cmd, { user: "root", timeoutMs: 20000 })
    .catch((e) => ({ stdout: "", stderr: String(e), exitCode: -1 }))
  console.log(`$ ${cmd}\n${r.stdout}${r.stderr}`)
}
await run("id; whoami; ls -la /home /home/rika-workspace /home/rika-workspace/workspace 2>&1 | head -40")
await run("ps aux | grep -i rika | grep -v grep | cut -c1-200 | head")
await run(
  "ls -la /home/rika-workspace/workspace/repo 2>&1 | head -5; find / -maxdepth 4 -name setup.log 2>/dev/null | head",
)
await run("cat $(find / -maxdepth 6 -path '*workspace/setup.log' 2>/dev/null | head -1) 2>/dev/null | tail -40")
await run(
  "cat /opt/rika/tool-manifest.json 2>/dev/null | head -5; ls /opt/rika 2>&1 | head; cat /opt/rika/VERSION 2>/dev/null",
)
