const animationTimers = new Map<number, ReturnType<typeof setTimeout>>()
let animationTimerId = 0

const requestAnimationFrameShim = (callback: FrameRequestCallback): number => {
  animationTimerId += 1
  const id = animationTimerId
  const timer = setTimeout(() => {
    animationTimers.delete(id)
    callback(Date.now())
  }, 0)
  animationTimers.set(id, timer)
  return id
}

const cancelAnimationFrameShim = (id: number): void => {
  const timer = animationTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    animationTimers.delete(id)
  }
}

const cssEscapeShim = (value: string): string => {
  const length = value.length
  const firstCodeUnit = value.charCodeAt(0)
  let result = ""

  for (let index = 0; index < length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    const character = value.charAt(index)
    const isDigit = codeUnit >= 48 && codeUnit <= 57
    const isUpperAlpha = codeUnit >= 65 && codeUnit <= 90
    const isLowerAlpha = codeUnit >= 97 && codeUnit <= 122

    if (codeUnit === 0) {
      result += "\uFFFD"
    } else if (
      (codeUnit >= 1 && codeUnit <= 31) ||
      codeUnit === 127 ||
      (index === 0 && isDigit) ||
      (index === 1 && isDigit && firstCodeUnit === 45)
    ) {
      result += `\\${codeUnit.toString(16)} `
    } else if (index === 0 && length === 1 && codeUnit === 45) {
      result += "\\-"
    } else if (codeUnit >= 128 || codeUnit === 45 || codeUnit === 95 || isDigit || isUpperAlpha || isLowerAlpha) {
      result += character
    } else {
      result += `\\${character}`
    }
  }

  return result
}

if (!("window" in globalThis)) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      requestAnimationFrame: requestAnimationFrameShim,
      cancelAnimationFrame: cancelAnimationFrameShim,
    },
  })
} else {
  globalThis.window.requestAnimationFrame ??= requestAnimationFrameShim
  globalThis.window.cancelAnimationFrame ??= cancelAnimationFrameShim
}

if (!("CSS" in globalThis)) {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: { escape: cssEscapeShim },
  })
} else {
  globalThis.CSS.escape ??= cssEscapeShim
}
