function configuredUserIds(value: string | undefined): string[] {
  return (value ?? '').split(/[\s,]+/).filter(Boolean)
}

export function requireAdminUserIds(value = process.env.ADMIN_USER_IDS): Set<string> {
  const userIds = configuredUserIds(value)
  if (userIds.length === 0) throw new Error('no admin user ids')
  if (userIds.some((userId) => !/^\d{17,20}$/.test(userId))) {
    throw new Error('ADMIN_USER_IDS must contain only Discord user IDs')
  }
  return new Set(userIds)
}

export function adminUserIds(value = process.env.ADMIN_USER_IDS): Set<string> {
  try {
    return requireAdminUserIds(value)
  } catch {
    return new Set()
  }
}

export function isAdminUser(userId: string, value?: string): boolean {
  return adminUserIds(value).has(userId)
}
