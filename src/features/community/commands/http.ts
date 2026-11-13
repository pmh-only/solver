// Only fixed, trusted HTTPS origins are used. Redirects are intentionally rejected.
let activeTransfers = 0

export async function fetchCommunityBytes(
  url: string,
  maxBytes: number,
  allowedHosts: readonly string[] = [
    'www.pizzint.watch',
    'cdn.discordapp.com',
    'media.discordapp.net'
  ]
): Promise<Buffer> {
  if (activeTransfers >= 4)
    throw new Error('다운로드 요청이 너무 많습니다. 잠시 후 다시 시도하세요.')
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024)
    throw new Error('잘못된 다운로드 제한입니다.')
  activeTransfers++
  try {
    return await readCommunityBytes(url, maxBytes, allowedHosts)
  } finally {
    activeTransfers--
  }
}

async function readCommunityBytes(
  url: string,
  maxBytes: number,
  allowedHosts: readonly string[]
): Promise<Buffer> {
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !allowedHosts.includes(parsed.hostname)
  ) {
    throw new Error('지원하지 않는 URL입니다. Discord 첨부 파일 URL을 사용하세요.')
  }
  const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`다운로드 실패 (${response.status})`)
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new Error('응답 크기가 너무 큽니다.')
  }
  if (!response.body) throw new Error('빈 응답입니다.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('응답 크기가 너무 큽니다.')
      chunks.push(value)
    }
    return Buffer.concat(chunks) as Buffer
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
