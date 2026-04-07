import { createConnection } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { createSocket } from 'node:dgram'
import { createHmac, createCipheriv, randomBytes } from 'node:crypto'
import { MessageFlags } from 'discord.js'
import type { Subcommand } from '../types.js'
import { container } from '../components.js'

const TIMEOUT = 3000
const SAMPLES = 3

// ── TCP ──────────────────────────────────────────────────────────────────────

function tcpOnce(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = performance.now()
    const s = createConnection({ host, port, timeout: TIMEOUT }, () => { resolve(performance.now() - t); s.destroy() })
    s.on('timeout', () => { s.destroy(); reject(new Error('timeout')) })
    s.on('error', reject)
  })
}

// ── TLS ──────────────────────────────────────────────────────────────────────

function tlsOnce(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = performance.now()
    const s = tlsConnect(
      { host, port: 443, servername: /^\d|:/.test(host) ? undefined : host, timeout: TIMEOUT, rejectUnauthorized: false },
      () => { resolve(performance.now() - t); s.destroy() }
    )
    s.on('timeout', () => { s.destroy(); reject(new Error('timeout')) })
    s.on('error', reject)
  })
}

// ── QUIC ─────────────────────────────────────────────────────────────────────
// Sends a valid QUIC v1 Initial packet (RFC 9000/9001) and times the first
// response byte — servers return Initial/Handshake or CONNECTION_CLOSE.

const QUIC_V1_SALT = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex')

function hmac256(key: Buffer, ...parts: Buffer[]): Buffer {
  const h = createHmac('sha256', key)
  for (const p of parts) h.update(p)
  return h.digest()
}

function hkdfExpand(prk: Buffer, info: Buffer, len: number): Buffer {
  const out: Buffer[] = []
  let t = Buffer.alloc(0)
  for (let i = 1; out.reduce((s, b) => s + b.length, 0) < len; i++) {
    t = hmac256(prk, t, info, Buffer.from([i]))
    out.push(t)
  }
  return Buffer.concat(out).subarray(0, len)
}

function expandLabel(prk: Buffer, label: string, len: number): Buffer {
  const l = Buffer.from(`tls13 ${label}`)
  return hkdfExpand(prk, Buffer.concat([Buffer.from([0, len, l.length]), l, Buffer.from([0])]) as Buffer, len)
}

/** Minimal TLS 1.3 ClientHello (no real key material — just enough for servers to respond) */
function buildClientHello(sni: string | null): Buffer {
  const exts: Buffer[] = []

  if (sni) {
    const n = Buffer.from(sni)
    exts.push(Buffer.concat([
      Buffer.from([0x00, 0x00]),                                   // type: server_name
      Buffer.from([0x00, n.length + 5]),                           // ext length
      Buffer.from([0x00, n.length + 3]),                           // list length
      Buffer.from([0x00]),                                         // name_type: host_name
      Buffer.from([0x00, n.length]),
      n,
    ]))
  }

  // supported_versions: TLS 1.3
  exts.push(Buffer.from([0x00, 0x2b, 0x00, 0x03, 0x02, 0x03, 0x04]))

  // supported_groups: x25519
  exts.push(Buffer.from([0x00, 0x0a, 0x00, 0x04, 0x00, 0x02, 0x00, 0x1d]))

  // key_share: x25519 with random key
  const k = randomBytes(32)
  exts.push(Buffer.concat([Buffer.from([0x00, 0x33, 0x00, 38, 0x00, 36, 0x00, 0x1d, 0x00, 32]), k]))

  // quic_transport_parameters (empty — enough to signal QUIC)
  exts.push(Buffer.from([0x00, 0x39, 0x00, 0x00]))

  const extData = Buffer.concat(exts)
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),           // legacy_version
    randomBytes(32),                     // random
    Buffer.from([0x00]),                 // session_id length = 0
    Buffer.from([0x00, 0x02, 0x13, 0x01]), // cipher_suites: TLS_AES_128_GCM_SHA256
    Buffer.from([0x01, 0x00]),           // compression: null
    Buffer.from([0x00, extData.length]),
    extData,
  ])

  return Buffer.concat([
    Buffer.from([0x01, 0x00, body.length >> 8, body.length & 0xff]), // HandshakeType + 3-byte length
    body,
  ])
}

function quicVarInt2(n: number): Buffer {
  return Buffer.from([0x40 | (n >> 8), n & 0xff]) // 2-byte varint (64 ≤ n ≤ 16383)
}

function buildQuicProbe(host: string): Buffer {
  const dcid = randomBytes(8)

  // Derive initial keys (RFC 9001 §5.2)
  const cs = expandLabel(hmac256(QUIC_V1_SALT, dcid), 'client in', 32)
  const key = expandLabel(cs, 'quic key', 16)
  const iv  = expandLabel(cs, 'quic iv',  12)
  const hp  = expandLabel(cs, 'quic hp',  16)

  // CRYPTO frame: type=0x06, offset=0x00, length (varint), data
  const ch = buildClientHello(/^\d|:/.test(host) ? null : host)
  const chLenVar = ch.length < 64
    ? Buffer.from([ch.length])
    : quicVarInt2(ch.length)
  const cryptoFrame = Buffer.concat([Buffer.from([0x06, 0x00]), chLenVar, ch])

  // Pad plaintext to ensure datagram ≥ 1200 bytes (RFC 9000 §14.1)
  // Header is ~22 bytes; tag is 16 bytes; 4-byte PN
  const padLen = Math.max(0, 1162 - cryptoFrame.length)
  const plaintext = Buffer.concat([cryptoFrame, Buffer.alloc(padLen, 0x00)])

  // 4-byte packet number (simplifies header-protection sample offset)
  const pn = Buffer.from([0x00, 0x00, 0x00, 0x00])
  const remaining = pn.length + plaintext.length + 16

  const hdr = Buffer.concat([
    Buffer.from([0xc3]),                        // Long hdr | Initial | 4-byte PN
    Buffer.from([0x00, 0x00, 0x00, 0x01]),      // QUIC v1
    Buffer.from([dcid.length]), dcid,
    Buffer.from([0x00, 0x00]),                  // SCID len=0, token len=0
    quicVarInt2(remaining),
    pn,
  ])

  // Nonce = iv XOR pn (RFC 9001 §5.3)
  const nonce = Buffer.from(iv)
  const pnVal = pn.readUInt32BE(0)
  for (let i = 0; i < 4; i++) nonce[8 + i] ^= (pnVal >> (24 - 8 * i)) & 0xff

  const cipher = createCipheriv('aes-128-gcm', key, nonce)
  cipher.setAAD(hdr)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  // Header protection (RFC 9001 §5.4.2):
  // sample = ct[0..15] (valid when PN is 4 bytes)
  const mask = createCipheriv('aes-128-ecb', hp, null).update(ct.subarray(0, 16))

  const protPn = Buffer.alloc(4)
  for (let i = 0; i < 4; i++) protPn[i] = pn[i] ^ mask[1 + i]

  return Buffer.concat([
    Buffer.from([hdr[0] ^ (mask[0] & 0x0f)]),  // protect lower 4 bits of first byte
    hdr.subarray(1, hdr.length - 4),            // header minus first byte and PN
    protPn,
    ct,
    tag,
  ])
}

function quicOnce(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const family = host.includes(':') ? 'udp6' : 'udp4'
    const sock = createSocket(family)
    const timer = setTimeout(() => { sock.close(); reject(new Error('timeout')) }, TIMEOUT)
    sock.once('message', () => { clearTimeout(timer); resolve(performance.now() - t); sock.close() })
    sock.on('error', (e) => { clearTimeout(timer); try { sock.close() } catch { /* already closed */ } reject(e) })
    const packet = buildQuicProbe(host)
    const t = performance.now()
    sock.send(packet, 443, host, (e) => { if (e) { clearTimeout(timer); try { sock.close() } catch { /* already closed */ } reject(e) } })
  })
}

// ── aggregate ─────────────────────────────────────────────────────────────────

type ProbeResult = { ms: number[]; err: string }

async function runProbe(fn: () => Promise<number>): Promise<ProbeResult> {
  const settled = await Promise.allSettled(Array.from({ length: SAMPLES }, fn))
  const ms = settled.filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled').map((r) => r.value)
  const err = (settled.find((r): r is PromiseRejectedResult => r.status === 'rejected') as PromiseRejectedResult | undefined)?.reason?.message ?? 'error'
  return { ms, err }
}

function fmtProbe(label: string, { ms, err }: ProbeResult): string {
  if (ms.length === 0) return `-# ${label}: ${err}`
  const min = Math.min(...ms).toFixed(1)
  const avg = (ms.reduce((a, b) => a + b) / ms.length).toFixed(1)
  const max = Math.max(...ms).toFixed(1)
  const loss = ms.length < SAMPLES ? ` loss=${SAMPLES - ms.length}/${SAMPLES}` : ''
  return `-# ${label}: min=${min}ms avg=${avg}ms max=${max}ms${loss}`
}

async function pingHost(host: string): Promise<string> {
  const [tcp, tls, quic] = await Promise.all([
    runProbe(() => tcpOnce(host, 80)),
    runProbe(() => tlsOnce(host)),
    runProbe(() => quicOnce(host)),
  ])
  return [
    `**${host}**`,
    fmtProbe('TCP :80 ', tcp),
    fmtProbe('TLS :443', tls),
    fmtProbe('QUIC:443', quic),
  ].join('\n')
}

export const subcommand: Subcommand = {
  name: 'ping',
  description: 'pong, or ping an IP/hostname',

  flags: {
    ip: { description: 'host or IP to ping', value: 'string' },
  },

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    const host = (flags.get('ip') as string | undefined) ?? restArgs

    if (host) {
      await interaction.deferReply({ flags: flags.has('pub') ? undefined : MessageFlags.Ephemeral })
      const result = await pingHost(host)
      const reply = container(args, flags, result)
      await interaction.editReply({ components: reply.components, flags: MessageFlags.IsComponentsV2 })
    } else {
      const latency = Date.now() - interaction.createdTimestamp
      await interaction.reply(container(args, flags, `pong: ${latency}ms`))
    }
  },
}
