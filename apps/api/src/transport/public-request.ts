export const canonicalPublicRequest = (input: {
  readonly request: Request
  readonly baseUrl: string | undefined
}): Request => {
  if (input.baseUrl === undefined) return input.request
  const incoming = new URL(input.request.url)
  const publicUrl = new URL(input.baseUrl)
  publicUrl.pathname = incoming.pathname
  publicUrl.search = incoming.search
  const headers = new Headers(input.request.headers)
  headers.set("host", publicUrl.host)
  for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto"]) headers.delete(name)
  const init: RequestInit = {
    method: input.request.method,
    headers,
    signal: input.request.signal,
  }
  if (input.request.body !== null) init.body = input.request.body
  return new Request(publicUrl.href, init)
}
