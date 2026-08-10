import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { getOrCreateStoredValue } from './kv-store.js'

const SESSION_SECRET_KEY = 'web-session-secret'

function sessionSecret(): string {
  const configured = process.env.WEB_SESSION_SECRET?.trim()
  if (configured && configured.length < 32) {
    throw new Error('WEB_SESSION_SECRET must contain at least 32 characters')
  }
  const secret =
    configured || getOrCreateStoredValue(SESSION_SECRET_KEY, randomBytes(32).toString('base64url'))
  if (secret.length < 32) throw new Error('Stored web session secret is invalid')
  return secret
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(sessionSecret()).digest()
}

export function initializeWebSecret(): void {
  sessionSecret()
}

export function encryptWebSecret(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.')
}

export function decryptWebSecret(value: string, invalidMessage: string): string {
  const parts = value.split('.')
  if (parts.length !== 3) throw new Error(invalidMessage)
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part!, 'base64url'))
  if (iv!.length !== 12 || tag!.length !== 16) throw new Error(invalidMessage)
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv!)
    decipher.setAuthTag(tag!)
    return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8')
  } catch {
    throw new Error(invalidMessage)
  }
}
