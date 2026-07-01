export async function launchMotel(argv, env) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  process.argv = [...argv]
  const motelPackage = "@kitlangton/motel"
  await import(`${motelPackage}/src/motel.ts`)
}
