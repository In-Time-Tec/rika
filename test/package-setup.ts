const root = new URL("..", import.meta.url).pathname

export const packageCli = async () => {
  const target = `${process.platform}-${process.arch}`
  const child = Bun.spawn(["bun", "run", "package", "--", "--target", target], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`Packaging ${target} exited with code ${exitCode}`)
}

export default packageCli
