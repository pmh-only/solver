import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRoleChatMail,
  createRoleChatMailBudget,
  roleChatMailIntent
} from '../role-chat-mail.js'
import { clearRuntimeIssuesForTests, runtimeIssueSummary } from '../runtime-health.js'

const fetchMock = vi.fn()
const address = 'gpt@pmh.codes'
const message = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  from: 'Person <person@example.com>',
  to: address,
  subject: 'Hello',
  preview: 'Preview',
  textContent: 'Body',
  receivedAt: '2026-11-08T00:00:00Z',
  ...overrides
})
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
function client(send = false) {
  return createRoleChatMail(send, new AbortController().signal, createRoleChatMailBudget())!
}

beforeEach(() => {
  clearRuntimeIssuesForTests()
  vi.stubEnv('MAIL_API_KEY', 'pmail_secret-test')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  clearRuntimeIssuesForTests()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('scoped role chat mail', () => {
  it('uses the existing key and fixed HTTPS endpoint without redirects', async () => {
    fetchMock.mockResolvedValueOnce(json({ messages: [message()] }))
    const result = JSON.parse(await client().execute('role_mail_list', '{}'))
    expect(result.messages).toHaveLength(1)
    const [url, options] = fetchMock.mock.calls[0]!
    expect(url.origin).toBe('https://mail.pmh.codes')
    expect(url.pathname).toBe('/api/external/v1/messages')
    expect(url.searchParams.get('q')).toBe(address)
    expect(url.searchParams.get('limit')).toBe('50')
    expect(options).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer pmail_secret-test' }
    })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(result)).not.toContain('pmail_secret-test')
  })

  it.each([
    { from: address, to: 'other@example.com' },
    { from: 'GPT <GPT@PMH.CODES>', to: 'other@example.com' },
    { to: `Other <other@example.com>, GPT <${address}>` },
    { to: `Team: ${address}, other@example.com;` }
  ])('accepts the exact address in From or To: %j', async (overrides) => {
    fetchMock.mockResolvedValueOnce(json(message(overrides)))
    expect(JSON.parse(await client().execute('role_mail_get', '{"id":1}')).message.id).toBe(1)
  })

  it.each([
    { to: 'gpt+alias@pmh.codes' },
    { to: 'gpt@pmh.codes.evil.example' },
    { to: 'notgpt@pmh.codes' },
    { to: 'gpt@pmh.codes <other@example.com>' },
    { to: 'other@example.com (gpt@pmh.codes)' },
    { from: '"gpt@pmh.codes" <person@example.com>', to: 'other@example.com' },
    { to: 'gpt@pmh.codes: other@example.com;' },
    { to: 'other@example.com', cc: address, bcc: address },
    { to: 'other@example.com', subject: address, textContent: address },
    { to: 'other@example.com\r\nTo: gpt@pmh.codes' }
  ])('does not expose out-of-scope bodies, headers, or attachments: %j', async (overrides) => {
    fetchMock.mockResolvedValueOnce(
      json(
        message({
          ...overrides,
          preview: 'PRIVATE-PREVIEW',
          htmlContent: 'PRIVATE-HTML',
          attachments: [{ filename: 'PRIVATE-FILE' }]
        })
      )
    )
    const result = await client().execute('role_mail_get', '{"id":1}')
    expect(JSON.parse(result)).toEqual({
      error: 'Message unavailable in the permitted mailbox scope.'
    })
    expect(result).not.toMatch(/PRIVATE|person@example/)
  })

  it('filters lists before exposing snippets or counts and returns only bounded allowlisted fields', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        messages: [
          message({ to: 'other@example.com', subject: 'PRIVATE' }),
          ...Array.from({ length: 20 }, (_, i) =>
            message({
              id: i + 2,
              preview: 'p'.repeat(1000),
              cc: 'PRIVATE-CC',
              attachments: ['PRIVATE-FILE']
            })
          )
        ],
        total: 99999,
        hasMore: true,
        secret: 'PRIVATE'
      })
    )
    const raw = await client().execute('role_mail_list', '{}')
    const result = JSON.parse(raw)
    expect(result.messages).toHaveLength(10)
    expect(result.messages[0].preview).toHaveLength(300)
    expect(result.messages[0]).not.toHaveProperty('textContent')
    expect(result).not.toHaveProperty('total')
    expect(raw).not.toMatch(/PRIVATE|99999/)
  })

  it('revalidates a requested message and bounds its body', async () => {
    fetchMock.mockResolvedValueOnce(json(message({ textContent: 'x'.repeat(20000) })))
    const result = JSON.parse(await client().execute('role_mail_get', '{"id":1}'))
    expect(result.message.body).toHaveLength(8000)
    expect(result.untrusted).toBe(true)
  })

  it('never accepts a different message ID than requested', async () => {
    fetchMock.mockResolvedValueOnce(json(message({ id: 2 })))
    expect(JSON.parse(await client().execute('role_mail_get', '{"id":1}'))).toHaveProperty('error')
  })

  it('queues one escaped plain-text email only to the fixed recipient', async () => {
    fetchMock.mockResolvedValueOnce(json({ jobId: 7, status: 'pending', secret: 'PRIVATE' }, 202))
    const mail = client(true)
    const input = JSON.stringify({
      subject: 'Hello',
      text: '<img src="https://evil.example"> & hi'
    })
    expect(JSON.parse(await mail.execute('role_mail_send', input))).toEqual({
      to: address,
      jobId: 7,
      status: 'queued',
      delivered: false
    })
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      to: address,
      subject: 'Hello',
      html: '<pre>&lt;img src="https://evil.example"&gt; &amp; hi</pre>'
    })
    expect(JSON.parse(await mail.execute('role_mail_send', input))).toHaveProperty('error')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    { to: 'other@example.com' },
    { cc: address },
    { bcc: address },
    { attachments: [] },
    { smtpServerId: 'other' },
    { subject: 'Hello\r\nBcc: other@example.com' }
  ])(
    'rejects recipient overrides, extra parameters and header injection before sending: %j',
    async (extra) => {
      const result = await client(true).execute(
        'role_mail_send',
        JSON.stringify({ subject: 'Hi', text: 'Body', ...extra })
      )
      expect(JSON.parse(result)).toHaveProperty('error')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it('never exposes sending for read-only requests or accepts arbitrary tool names', async () => {
    const mail = client()
    expect(mail.tools.map((tool) => tool.name)).toEqual(['role_mail_list', 'role_mail_get'])
    await expect(mail.execute('role_mail_send', '{}')).rejects.toThrow()
    await expect(mail.execute('shell', '{}')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('handles timeouts and provider failures safely without retrying uncertain sends', async () => {
    fetchMock.mockRejectedValueOnce(new Error('pmail_secret-test: upstream timeout'))
    const mail = client(true)
    const args = JSON.stringify({ subject: 'Hi', text: 'Body' })
    const result = await mail.execute('role_mail_send', args)
    expect(result).not.toContain('pmail_secret-test')
    expect(runtimeIssueSummary()).toContain('role-chat-mail')
    expect(runtimeIssueSummary()).not.toContain('pmail_secret-test')
    expect(JSON.parse(result)).toHaveProperty('error')
    await mail.execute('role_mail_send', args)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each(['http', 'json', 'size-header', 'size-stream'])(
    'rejects failed, malformed or oversized responses (%s)',
    async (kind) => {
      const response =
        kind === 'http'
          ? new Response('secret-provider-body', { status: 403 })
          : kind === 'json'
            ? new Response('secret-provider-body')
            : kind === 'size-header'
              ? new Response('{}', { headers: { 'Content-Length': String(300 * 1024) } })
              : new Response('x'.repeat(300 * 1024))
      fetchMock.mockResolvedValueOnce(response)
      const result = await client().execute('role_mail_list', '{}')
      expect(JSON.parse(result)).toHaveProperty('error')
      expect(result).not.toContain('secret-provider-body')
    }
  )

  it('bounds calls and validates IDs and arguments before network access', async () => {
    const mail = client()
    expect(
      JSON.parse(await mail.execute('role_mail_get', '{"id":"../../attachments/1"}'))
    ).toHaveProperty('error')
    expect(
      JSON.parse(await mail.execute('role_mail_list', '{"mailbox":"private"}'))
    ).toHaveProperty('error')
    await expect(mail.execute('role_mail_list', '{}')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is unavailable without an existing API key', () => {
    vi.stubEnv('MAIL_API_KEY', '')
    expect(createRoleChatMail(false, new AbortController().signal)).toBeUndefined()
  })

  it('bounds process-wide concurrency and send attempts and expires rate windows', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const reserve = createRoleChatMailBudget()
    const first = reserve(false)
    const second = reserve(false)
    expect(() => reserve(false)).toThrow('budget')
    first()
    first()
    second()
    for (let i = 0; i < 5; i++) reserve(true)()
    expect(() => reserve(true)).toThrow('budget')
    for (let i = 7; i < 60; i++) reserve(false)()
    expect(() => reserve(false)).toThrow('budget')
    clock.mockReturnValue(1_600_000)
    reserve(false)()
    expect(() => reserve(true)).toThrow('budget')
    clock.mockReturnValue(4_600_000)
    reserve(true)()
  })

  it('recognizes only the current mail intent and does not grant sends for reading', () => {
    expect(roleChatMailIntent('메일 보여줘')).toEqual({ read: true, send: false })
    expect(roleChatMailIntent('gpt@pmh.codes로 메일 보내줘')).toEqual({ read: true, send: true })
    expect(roleChatMailIntent('안녕')).toEqual({ read: false, send: false })
  })
})
