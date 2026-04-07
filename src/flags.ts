export type Flags = Map<string, string | true>

export interface ParseResult {
  bare: string  // args with all flags stripped
  flags: Flags
}

export function parseFlags(input: string): ParseResult {
  const flags: Flags = new Map()
  const parts = input.trim().split(/\s+/)
  const remaining: string[] = []

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.startsWith('--')) {
      const key = part.slice(2)
      const next = parts[i + 1]
      if (next && !next.startsWith('-')) {
        flags.set(key, next)
        i++
      } else {
        flags.set(key, true)
      }
    } else if (part.startsWith('-') && part.length > 1 && !/^-\d/.test(part)) {
      // -abc → each char is a boolean flag
      for (const ch of part.slice(1)) {
        flags.set(ch, true)
      }
    } else {
      remaining.push(part)
    }
  }

  return { bare: remaining.join(' '), flags }
}

/** Build alias→fullName map from a FlagDef record */
export function buildAliasMap(defs: Record<string, { alias?: string }>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [name, def] of Object.entries(defs)) {
    if (def.alias) map.set(def.alias, name)
  }
  return map
}

/** Resolve single-char alias keys in flags to their full names */
export function resolveAliases(flags: Flags, aliasMap: Map<string, string>): Flags {
  const resolved: Flags = new Map()
  for (const [k, v] of flags) {
    resolved.set(aliasMap.get(k) ?? k, v)
  }
  return resolved
}
