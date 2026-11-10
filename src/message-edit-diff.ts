import { escapeMarkdown } from 'discord.js'

type Part = { deleted: boolean; value: string }

export function formatMessageEditDiff(before: string, after: string, limit = 3900): string {
  // Work with code points so an edit cannot split an emoji's surrogate pair.
  const old = Array.from(before.slice(0, 4000))
  const next = Array.from(after.slice(0, 4000))
  const parts: Part[] = []
  const append = (deleted: boolean, value: string) => {
    if (!value) return
    const last = parts.at(-1)
    if (last?.deleted === deleted) last.value += value
    else parts.push({ deleted, value })
  }
  let start = 0
  while (start < old.length && start < next.length && old[start] === next[start]) start++
  let end = 0
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - end - 1] === next[next.length - end - 1]
  )
    end++
  append(false, old.slice(0, start).join(''))
  const a = old.slice(start, old.length - end)
  const b = next.slice(start, next.length - end)
  // Cap quadratic work for completely rewritten long messages.
  if ((a.length + 1) * (b.length + 1) > 1_000_000) {
    append(true, a.join(''))
    append(false, b.join(''))
  } else {
    const width = b.length + 1
    const lengths = new Uint16Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lengths[i * width + j] =
          a[i] === b[j]
            ? lengths[(i + 1) * width + j + 1]! + 1
            : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        append(false, a[i++]!)
        j++
      } else if (
        i < a.length &&
        (j === b.length || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)
      ) {
        append(true, a[i++]!)
      } else {
        append(false, b[j++]!)
      }
    }
  }
  append(false, end ? old.slice(old.length - end).join('') : '')

  let result = ''
  for (const part of parts) {
    const remaining = limit - result.length - (part.deleted ? 4 : 0) - 1
    let value = ''
    let truncated = false
    for (const char of part.value) {
      // These markers are only escaped by escapeMarkdown when seen in context;
      // escape them explicitly because rendering/truncation works per code point.
      const escaped = ['~', '|', '#', '>'].includes(char) ? `\\${char}` : escapeMarkdown(char)
      if (value.length + escaped.length > remaining) {
        truncated = true
        break
      }
      value += escaped
    }
    if (value) result += part.deleted ? `~~${value}~~` : value
    if (truncated) return result + '…'
  }
  // Discord rejects empty text displays.
  return result || '\u200b'
}

export function formatMessageEditHistory(versions: { content: string }[]): string {
  const count = Math.max(1, versions.length - 1)
  const limit = Math.floor((3900 - (count - 1) * 2) / count)
  if (versions.length <= 1) return formatMessageEditDiff('', versions[0]?.content ?? '', limit)
  return versions
    .slice(1)
    .map((version, index) =>
      formatMessageEditDiff(versions[index]!.content, version.content, limit)
    )
    .join('\n\n')
}
