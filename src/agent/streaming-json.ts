function readJsonString(
  value: string,
  start: number
): { text: string; end: number; complete: boolean } {
  let result = ''
  for (let index = start + 1; index < value.length; index++) {
    const char = value[index]!
    if (char === '"') return { text: result, end: index, complete: true }
    if (char !== '\\') {
      result += char
      continue
    }

    const escaped = value[++index]
    if (escaped === undefined) break
    if (escaped === 'u') {
      const code = value.slice(index + 1, index + 5)
      if (!/^[0-9a-f]{4}$/i.test(code)) break
      result += String.fromCharCode(Number.parseInt(code, 16))
      index += 4
      continue
    }
    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t'
    }
    result += escapes[escaped] ?? escaped
  }
  return { text: result, end: value.length, complete: false }
}

function streamedComponentContent(value: string, start: number): string {
  const contents: string[] = []
  let depth = 0

  for (let index = start; index < value.length; index++) {
    const char = value[index]!
    if (char === '{' || char === '[') {
      depth++
      continue
    }
    if (char === '}' || char === ']') {
      depth--
      if (depth === 0) break
      continue
    }
    if (char !== '"') continue

    const key = readJsonString(value, index)
    if (!key.complete) break
    index = key.end
    if (key.text !== 'content') continue

    let valueStart = key.end + 1
    while (/\s/.test(value[valueStart] ?? '')) valueStart++
    if (value[valueStart] !== ':') continue
    valueStart++
    while (/\s/.test(value[valueStart] ?? '')) valueStart++
    if (value[valueStart] !== '"') continue

    const content = readJsonString(value, valueStart)
    contents.push(content.text)
    index = content.end
    if (!content.complete) break
  }

  return contents.filter(Boolean).join('\n\n')
}

export function streamedJsonContent(value: string): string {
  let depth = 0
  let expectingKey = false
  let componentsStart = -1

  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (char === '{' || char === '[') {
      depth++
      if (depth === 1 && char === '{') expectingKey = true
      continue
    }
    if (char === '}' || char === ']') {
      depth--
      continue
    }
    if (char === ',' && depth === 1) {
      expectingKey = true
      continue
    }
    if (char !== '"') continue

    const parsed = readJsonString(value, index)
    if (depth !== 1 || !expectingKey) {
      if (!parsed.complete) break
      index = parsed.end
      continue
    }
    if (!parsed.complete) break

    let valueStart = parsed.end + 1
    while (/\s/.test(value[valueStart] ?? '')) valueStart++
    if (value[valueStart] !== ':') return ''
    valueStart++
    while (/\s/.test(value[valueStart] ?? '')) valueStart++
    expectingKey = false

    if (parsed.text === 'content' && value[valueStart] === '"') {
      return readJsonString(value, valueStart).text
    }
    if (parsed.text === 'components' && value[valueStart] === '[') {
      componentsStart = valueStart
    }
    index = parsed.end
  }
  return componentsStart >= 0 ? streamedComponentContent(value, componentsStart) : ''
}
