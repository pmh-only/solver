import { escapeMarkdown } from 'discord.js'

type Part = { deleted: boolean; value: string }
type Change = { kind: 'equal' | 'delete' | 'insert'; value: string }

export function hasMessageEditDeletion(before: string, after: string): boolean {
  // An insertion-only edit preserves every old code point in the same order.
  const original = Array.from(before)
  let matched = 0
  for (const char of after) {
    if (char === original[matched]) matched++
  }
  return matched < original.length
}

function changes(before: string, after: string): Change[] {
  // Work with code points so an edit cannot split an emoji's surrogate pair.
  const old = Array.from(before.slice(0, 4000))
  const next = Array.from(after.slice(0, 4000))
  const parts: Change[] = []
  const append = (kind: Change['kind'], value: string) => {
    if (!value) return
    const last = parts.at(-1)
    if (last?.kind === kind) last.value += value
    else parts.push({ kind, value })
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
  append('equal', old.slice(0, start).join(''))
  const a = old.slice(start, old.length - end)
  const b = next.slice(start, next.length - end)
  // Cap quadratic work for completely rewritten long messages.
  if ((a.length + 1) * (b.length + 1) > 1_000_000) {
    append('delete', a.join(''))
    append('insert', b.join(''))
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
        append('equal', a[i++]!)
        j++
      } else if (
        i < a.length &&
        (j === b.length || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)
      ) {
        append('delete', a[i++]!)
      } else {
        append('insert', b[j++]!)
      }
    }
  }
  append('equal', end ? old.slice(old.length - end).join('') : '')
  return parts
}

function render(parts: Part[], limit: number): string {
  let result = ''
  for (const part of parts) {
    const remaining = limit - result.length - (part.deleted ? 4 : 0) - 1
    let value = ''
    let truncated = false
    for (const char of part.value.replace(/[\r\n\u2028\u2029]+/g, ' ')) {
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
  return result
}

export function formatMessageEditDiff(before: string, after: string, limit = 3900): string {
  return render(
    changes(before, after).map((part) => ({
      deleted: part.kind === 'delete',
      value: part.value
    })),
    limit
  )
}

export function formatMessageEditHistory(versions: { content: string }[]): string {
  const retained = versions.slice(-10)
  let timeline: Part[] = Array.from(retained[0]?.content.slice(0, 4000) ?? '', (value) => ({
    deleted: false,
    value
  }))
  for (let index = 1; index < retained.length; index++) {
    const next: Part[] = []
    let cursor = 0
    const keepDeletions = () => {
      while (timeline[cursor]?.deleted) next.push(timeline[cursor++]!)
    }
    // Apply each edit to the live characters, preserving older deletions in
    // place instead of repeating the whole sentence for every stored version.
    for (const part of changes(retained[index - 1]!.content, retained[index]!.content)) {
      for (const value of part.value) {
        keepDeletions()
        if (part.kind === 'insert') next.push({ deleted: false, value })
        else {
          next.push({ deleted: part.kind === 'delete', value })
          cursor++
        }
      }
    }
    keepDeletions()
    timeline = next
  }
  if (!timeline.some((part) => part.deleted)) return ''
  const parts: Part[] = []
  for (const part of timeline) {
    const last = parts.at(-1)
    if (last?.deleted === part.deleted) last.value += part.value
    else parts.push({ ...part })
  }
  return render(parts, 3900)
}
