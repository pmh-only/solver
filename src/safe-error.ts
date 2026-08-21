const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    if (/^\/webhooks\/[^/]+\/[^/]+/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/^(\/webhooks\/[^/]+)\/[^/]+/, '$1/[redacted]')
    }
    return url.toString()
  } catch {
    return '[redacted URL]'
  }
}

export function safeErrorMessage(error: unknown, maxLength = 2_000): string {
  const raw = error instanceof Error ? error.message : String(error || 'unknown error')
  return raw
    .replace(URL_PATTERN, sanitizeUrl)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(token|api[_-]?key|secret|password|authorization)(\s*[:=]\s*)[^\s,;]+/gi,
      '$1$2[redacted]'
    )
    .slice(0, maxLength)
}
