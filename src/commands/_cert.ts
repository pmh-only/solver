import { connect as tlsConnect } from 'node:tls'
import { isIP } from 'node:net'

const CERT_TIMEOUT = 5000

export interface CertificateInfo {
  host: string
  port: number
  subject: Record<string, string>
  issuer: Record<string, string>
  subjectAltName?: string
  validFrom: string
  validTo: string
  serialNumber: string
  fingerprint256?: string
  authorized: boolean
  authorizationError?: string | null
  protocol?: string
  cipher?: string
}

function normalizeCertParty(
  input: Record<string, string | string[] | undefined> | undefined
): Record<string, string> {
  if (!input) return {}

  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    result[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return result
}

function parseTarget(input: string): { host: string; port: number } {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('no host')

  if (trimmed.startsWith('[')) {
    const match = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/)
    if (!match) throw new Error('bad host')
    return { host: match[1], port: match[2] ? Number(match[2]) : 443 }
  }

  const parts = trimmed.split(':')
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: Number(parts[1]) }
  }

  return { host: trimmed, port: 443 }
}

async function lookup(target: string): Promise<CertificateInfo> {
  const { host, port } = parseTarget(target)

  return await new Promise((resolve, reject) => {
    const socket = tlsConnect(
      {
        host,
        port,
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: false
      },
      () => {
        const cert = socket.getPeerCertificate()
        const cipher = socket.getCipher()
        resolve({
          host,
          port,
          subject: normalizeCertParty(cert.subject),
          issuer: normalizeCertParty(cert.issuer),
          subjectAltName: cert.subjectaltname,
          validFrom: cert.valid_from ?? 'unknown',
          validTo: cert.valid_to ?? 'unknown',
          serialNumber: cert.serialNumber ?? 'unknown',
          fingerprint256: cert.fingerprint256,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          protocol: socket.getProtocol() ?? undefined,
          cipher: cipher
            ? `${cipher.name}${cipher.version ? ` (${cipher.version})` : ''}`
            : undefined
        })
        socket.end()
      }
    )

    socket.setTimeout(CERT_TIMEOUT)
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('tls timeout'))
    })
    socket.once('error', (error) => reject(error))
  })
}

export const certClient = {
  lookup
}
