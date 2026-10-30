/** One bounded query language shared by SQL candidate selection and live Discord verification. */
export class ArchiveQueryError extends Error {}
type Kind = 'text' | 'phrase' | 'word' | 'wildcard' | 'fuzzy'
export interface SearchTerm {
  kind: Kind
  value: string
  distance: number
  required: boolean
}
type Node =
  | { op: 'term'; index: number }
  | { op: 'not'; child: Node }
  | { op: 'and' | 'or'; left: Node; right: Node }
type Token =
  | { kind: 'term'; term: SearchTerm }
  | { kind: 'and' | 'or' | 'not' | 'plus' | '(' | ')' }
export interface ArchiveQuery {
  source: string
  terms: SearchTerm[]
  root: Node
  required: number[]
  positive: number[]
}
export interface SearchPart {
  text: string
  field: 'content' | 'embeds' | 'metadata'
}
const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu
const MAX_TEXT = 65536

function fail(message: string): never {
  throw new ArchiveQueryError(message)
}
function lex(source: string): Token[] {
  const result: Token[] = []
  for (let i = 0; i < source.length;) {
    if (/\s/u.test(source[i]!)) {
      i++
      continue
    }
    if (result.length >= 160) fail('검색 문법이 너무 복잡합니다. 검색어를 줄여 주세요.')
    const ch = source[i]!
    if (ch === '(' || ch === ')') {
      result.push({ kind: ch })
      i++
      continue
    }
    if (ch === '+' || ch === '-' || ch === '!') {
      result.push({ kind: ch === '+' ? 'plus' : 'not' })
      i++
      continue
    }
    if (source.startsWith('&&', i) || source.startsWith('||', i)) {
      result.push({ kind: ch === '&' ? 'and' : 'or' })
      i += 2
      continue
    }
    if (ch === '"') {
      let value = ''
      let closed = false
      for (i++; i < source.length; i++) {
        const next = source[i]!
        if (next === '"') {
          closed = true
          i++
          break
        }
        if (next === '\n' || next === '\r') fail('따옴표 구문에는 줄바꿈을 넣을 수 없습니다.')
        if (next === '\\') {
          i++
          if (source[i] !== '"' && source[i] !== '\\')
            fail('따옴표 안에서는 \\"와 \\\\만 이스케이프할 수 있습니다.')
        }
        value += source[i]!
      }
      if (!closed) fail('닫는 따옴표가 필요합니다.')
      if (!value.trim() || value.length > 200) fail('정확한 구문은 1–200자로 입력해 주세요.')
      result.push({
        kind: 'term',
        term: { kind: 'phrase', value: value.toLowerCase(), distance: 0, required: true }
      })
      continue
    }
    let value = ''
    let escaped = false
    while (
      i < source.length &&
      !/[\s()"!]/u.test(source[i]!) &&
      !source.startsWith('&&', i) &&
      !source.startsWith('||', i)
    ) {
      if (source[i] === '\\') {
        escaped = true
        i++
        if (i >= source.length) fail('이스케이프할 문자가 필요합니다.')
      }
      value += source[i++]!
    }
    if (!value || value.length > 200) fail('검색어는 1–200자로 입력해 주세요.')
    if (!escaped && /^(AND|OR|NOT)$/i.test(value)) {
      result.push({ kind: value.toLowerCase() as 'and' | 'or' | 'not' })
      continue
    }
    const fuzzy = !escaped && /^(.*?)~([12]?)$/.exec(value)
    let kind: Kind = 'text'
    let distance = 0
    if (fuzzy) {
      value = fuzzy[1]!
      distance = Number(fuzzy[2] || 1)
      kind = 'fuzzy'
      if (!/^[\p{L}\p{N}_]{2,32}$/u.test(value))
        fail('퍼지 검색은 2–32자 단어 뒤에 ~1 또는 ~2를 붙여 주세요.')
    } else if (!escaped && value.includes('~')) fail('퍼지 검색은 ~, ~1, ~2만 지원합니다.')
    else if (!escaped && value.startsWith('=')) {
      value = value.slice(1)
      kind = 'word'
      if (!/^[\p{L}\p{N}_]{1,64}$/u.test(value))
        fail('= 뒤에는 정확히 일치할 단어를 입력해 주세요.')
    } else if (!escaped && /[*?]/.test(value)) {
      kind = 'wildcard'
      if (
        value.length > 64 ||
        (value.match(/[*?]/g) ?? []).length > 3 ||
        value.replace(/[*?]/g, '').length < 2 ||
        !/^[\p{L}\p{N}_*?]+$/u.test(value)
      )
        fail(
          '와일드카드는 단어 안에서 *와 ?를 최대 3개 사용하고, 일반 문자를 2자 이상 포함해 주세요.'
        )
    }
    result.push({
      kind: 'term',
      term: { kind, value: value.toLowerCase(), distance, required: false }
    })
  }
  return result
}

export function parseArchiveQuery(input: string): ArchiveQuery {
  const source = input.trim()
  if (!source || source.length > 4000) fail('검색식은 1–4000자로 입력해 주세요.')
  const tokens = lex(source)
  const terms: SearchTerm[] = []
  let at = 0
  function unary(depth: number): Node {
    if (depth > 8) fail('괄호와 NOT은 8단계까지만 중첩할 수 있습니다.')
    const token = tokens[at++]
    if (!token) fail('연산자 뒤에 검색어가 필요합니다.')
    if (token.kind === 'not') return { op: 'not', child: unary(depth + 1) }
    if (token.kind === '(') {
      const node = or(depth + 1)
      if (tokens[at++]?.kind !== ')') fail('닫는 괄호가 필요합니다.')
      return node
    }
    if (token.kind === 'plus') {
      const next = tokens[at]
      if (next?.kind !== 'term') fail('+ 뒤에는 필수 검색어나 따옴표 구문이 필요합니다.')
      next.term.required = true
      return unary(depth + 1)
    }
    if (token.kind !== 'term') fail('연산자 또는 괄호 위치를 확인해 주세요.')
    if (terms.length >= 24) fail('검색어는 최대 24개까지 사용할 수 있습니다.')
    const index = terms.push(token.term) - 1
    return { op: 'term', index }
  }
  function and(depth: number): Node {
    let node = unary(depth)
    while (at < tokens.length && tokens[at]!.kind !== 'or' && tokens[at]!.kind !== ')') {
      if (tokens[at]!.kind === 'and') at++
      node = { op: 'and', left: node, right: unary(depth) }
    }
    return node
  }
  function or(depth: number): Node {
    let node = and(depth)
    while (tokens[at]?.kind === 'or') {
      at++
      node = { op: 'or', left: node, right: and(depth) }
    }
    return node
  }
  const root = or(0)
  if (at !== tokens.length) fail('여는 괄호 또는 연산자가 필요합니다.')
  if (terms.filter((term) => term.kind === 'fuzzy').length > 4)
    fail('퍼지 검색어는 한 검색식에 최대 4개까지 사용할 수 있습니다.')
  const positive: number[] = []
  function walk(node: Node, negated = false) {
    if (node.op === 'term') {
      if (!negated) positive.push(node.index)
    } else if (node.op === 'not') walk(node.child, !negated)
    else {
      walk(node.left, negated)
      walk(node.right, negated)
    }
  }
  walk(root)
  if (!positive.length) fail('제외 조건만으로 검색할 수 없습니다. 찾을 검색어도 입력해 주세요.')
  return {
    source,
    terms,
    root,
    positive,
    required: positive.filter((index) => terms[index]!.required)
  }
}

/** Kept asynchronous to share the existing handler injection contract, without any AI calls. */
export async function prepareArchiveSearch(
  input: string
): Promise<{ keyword: string; scope: 'all' | 'content' | 'embeds' } | null> {
  return { keyword: parseArchiveQuery(input).source, scope: 'all' as const }
}

function tree(node: Node, test: (index: number) => boolean): boolean {
  if (node.op === 'term') return test(node.index)
  if (node.op === 'not') return !tree(node.child, test)
  return node.op === 'and'
    ? tree(node.left, test) && tree(node.right, test)
    : tree(node.left, test) || tree(node.right, test)
}
function editDistance(a: string, b: string, max: number): boolean {
  const x = [...a],
    y = [...b]
  if (Math.abs(x.length - y.length) > max) return false
  let row = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i++) {
    const next = Array<number>(y.length + 1).fill(max + 1)
    next[0] = i
    let best = next[0]!
    for (let j = Math.max(1, i - max); j <= Math.min(y.length, i + max); j++) {
      next[j] = Math.min(
        next[j - 1]! + 1,
        row[j]! + 1,
        row[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1)
      )
      best = Math.min(best, next[j]!)
    }
    if (best > max) return false
    row = next
  }
  return row[y.length]! <= max
}
function wildcard(pattern: string, word: string): boolean {
  // A bounded glob DP, not a user-controlled regular expression.
  const chars = [...word]
  let row = [true, ...chars.map(() => false)]
  for (const ch of pattern) {
    const next = [ch === '*' && row[0]!]
    for (let i = 1; i <= chars.length; i++)
      next[i] =
        ch === '*' ? row[i]! || next[i - 1]! : row[i - 1]! && (ch === '?' || ch === chars[i - 1])
    row = next
  }
  return row[chars.length]!
}
function termMatches(term: SearchTerm, text: string, words: string[]): boolean {
  if (term.kind === 'text' || term.kind === 'phrase') return text.includes(term.value)
  if (term.kind === 'word') return words.includes(term.value)
  return words.some(
    (word) =>
      word.length <= 64 &&
      (term.kind === 'wildcard'
        ? wildcard(term.value, word)
        : editDistance(term.value, word, term.distance))
  )
}

export function messageSearchParts(message: unknown): SearchPart[] {
  const result: SearchPart[] = []
  const stack: { value: unknown; field: SearchPart['field']; depth: number }[] = [
    { value: message, field: 'metadata', depth: 0 }
  ]
  let size = 0,
    visited = 0
  while (stack.length && visited++ < 16384 && result.length < 4096 && size < MAX_TEXT) {
    const { value, field, depth } = stack.pop()!
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).slice(0, Math.min(16384, MAX_TEXT - size))
      result.push({ text, field })
      size += text.length + 1
    } else if (value && typeof value === 'object' && depth < 32) {
      const entries = Object.entries(value).slice(0, 4096)
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i]!
        if (/^(?:token|access_token|authorization|client_secret)$/i.test(key)) continue
        stack.push({
          value: child,
          field:
            depth === 0
              ? key === 'content'
                ? 'content'
                : key === 'embeds'
                  ? 'embeds'
                  : 'metadata'
              : field,
          depth: depth + 1
        })
      }
    }
  }
  return result
}

export function matchArchiveQuery(query: ArchiveQuery, parts: SearchPart[]) {
  const text = parts
    .map((part) => part.text)
    .join('\n')
    .toLowerCase()
    .slice(0, MAX_TEXT)
  const words = [...new Set((text.match(TOKEN_PATTERN) ?? []).slice(0, 2048))]
  const hits = query.terms.map((term) => termMatches(term, text, words))
  if (!tree(query.root, (index) => hits[index]!) || !query.required.every((index) => hits[index]))
    return null
  for (const index of query.positive) {
    if (!hits[index]) continue
    const term = query.terms[index]!
    const part = parts.find((part) =>
      termMatches(
        term,
        part.text.toLowerCase(),
        (part.text.toLowerCase().match(TOKEN_PATTERN) ?? []).slice(0, 2048)
      )
    )
    if (part) {
      const at = Math.max(0, part.text.toLowerCase().indexOf(term.value))
      const start = Math.max(0, at - 60)
      return {
        field: part.field,
        snippet: `${start ? '…' : ''}${part.text.slice(start, start + 220)}`
      }
    }
  }
  const part = parts.find((part) => part.field === 'content' && part.text) ?? parts[0]
  return { field: part?.field ?? ('metadata' as const), snippet: part?.text.slice(0, 220) ?? '' }
}

export function compileArchiveQuery(query: ArchiveQuery) {
  const params: (string | number)[] = []
  const columns = query.terms.map((term, i) => {
    let sql: string
    if (term.kind === 'text' || term.kind === 'phrase') {
      params.push(term.value)
      sql = 'strpos(d.search_text,?)>0'
    } else if (term.kind === 'word') {
      params.push(term.value)
      sql = 'list_contains(d.search_words,?)'
    } else if (term.kind === 'wildcard') {
      params.push(term.value.replace(/_/g, '\\_').replace(/\*/g, '%').replace(/\?/g, '_'))
      sql =
        "EXISTS(SELECT 1 FROM unnest(d.search_words) u(word) WHERE length(word)<=64 AND word LIKE ? ESCAPE '\\')"
    } else {
      params.push(term.value, [...term.value].length, term.distance, term.value, term.distance)
      // DuckDB levenshtein measures UTF-8 bytes. Map each pair's Unicode alphabet
      // to distinct single-byte characters first, so Korean edits count as one.
      sql = `EXISTS(SELECT 1 FROM unnest(d.search_words) u(word)
        CROSS JOIN LATERAL (SELECT list_distinct(string_split(left(word,64)||?,'')) AS alphabet) a
        WHERE length(word)<=64 AND abs(length(word)-?)<=? AND levenshtein(
          array_to_string(list_transform(string_split(left(word,64),''), lambda c: chr(list_position(a.alphabet,c)::INTEGER)),''),
          array_to_string(list_transform(string_split(?,''), lambda c: chr(list_position(a.alphabet,c)::INTEGER)),'')
        )<=?)`
    }
    return `(${sql}) AS q${i}`
  })
  function expression(node: Node): string {
    if (node.op === 'term') return `q${node.index}`
    if (node.op === 'not') return `(NOT ${expression(node.child)})`
    return `(${expression(node.left)} ${node.op.toUpperCase()} ${expression(node.right)})`
  }
  const predicate = [expression(query.root), ...query.required.map((i) => `q${i}`)].join(' AND ')
  const score = query.positive
    .map(
      (i) =>
        `CASE WHEN q${i} THEN ${query.terms[i]!.kind === 'phrase' ? 30 : query.terms[i]!.kind === 'fuzzy' ? 5 : 10} ELSE 0 END`
    )
    .join('+')
  return { columns: columns.join(','), predicate, score, params }
}
