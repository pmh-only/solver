export interface AgentSession {
  readonly scope: 'shared' | 'private' | 'feature'
  /** Persisted name; private names are opaque and resolved by sessions/privacy. */
  readonly name: string
}

export function agentSession(name: string): AgentSession {
  return {
    name,
    scope: name.startsWith('__feature:private:')
      ? 'private'
      : name.startsWith('__feature:')
        ? 'feature'
        : 'shared'
  }
}

/** Public/web session selectors can address only the shared namespace. */
export function sharedAgentSession(sessionName: string): AgentSession {
  const name = sessionName.trim()
  if (name.startsWith('__feature:'))
    throw new Error('Session name is reserved for internal sessions')
  if (!name) throw new Error('Session name must not be empty')
  if (name.length > 100) throw new Error('Session name must not exceed 100 characters')
  return { scope: 'shared', name }
}
