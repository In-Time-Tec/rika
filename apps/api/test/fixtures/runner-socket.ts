export const testWebSocketConstructor =
  (authorization: string, dpop?: string) => (url: string, protocols?: string | string[]) => {
    let selected: string[] | undefined
    if (protocols !== undefined) selected = Array.isArray(protocols) ? protocols : [protocols]
    return new WebSocket(url, {
      protocols: selected,
      headers: dpop === undefined ? { authorization } : { authorization, dpop },
    })
  }
