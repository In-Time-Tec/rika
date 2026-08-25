import { Function } from "effect"

const websocketUrlImpl = (path: string, requestUrl: string): string => {
  const url = new URL(path, requestUrl)
  if (url.protocol === "http:") url.protocol = "ws:"
  else if (url.protocol === "https:") url.protocol = "wss:"
  else throw new TypeError(`Unsupported HTTP protocol: ${url.protocol}`)
  return url.toString()
}

export const websocketUrl: {
  (requestUrl: string): (path: string) => string
  (path: string, requestUrl: string): string
} = Function.dual(2, websocketUrlImpl)
