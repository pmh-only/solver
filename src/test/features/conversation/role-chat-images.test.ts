import { Collection, type Attachment, type Message } from 'discord.js'
import { describe, expect, it, vi } from 'vitest'
import {
  collectRoleChatImages,
  createRoleChatImageBudget,
  decodeRoleChatImage,
  requestsRoleChatImage,
  roleChatImageUrl
} from '../../../features/conversation/images.js'

const URL =
  'https://cdn.discordapp.com/attachments/777777777777777777/888888888888888888/photo.png?ex=123&is=456&hm=789'
function file(overrides: Partial<Attachment> = {}): Attachment {
  return { url: URL, contentType: 'image/png', size: 1024, ...overrides } as Attachment
}
function message(id: string, files: Attachment[]): Message {
  return {
    id,
    author: { id: '555555555555555555' },
    attachments: new Collection(files.map((item, i) => [String(i), item]))
  } as unknown as Message
}

describe('bounded role-chat image selection', () => {
  it('bounds image concurrency and hourly attempts and releases reservations idempotently', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const reserve = createRoleChatImageBudget()
      const first = reserve('guild/user1')
      const second = reserve('guild/user2')
      expect(() => reserve('guild/user3')).toThrow('budget')
      first()
      first()
      const third = reserve('guild/user3')
      expect(() => reserve('guild/user4')).toThrow('budget')
      second()
      third()
      expect(() => reserve('guild/user1')).toThrow('budget')
      for (let i = 3; i < 20; i++) reserve(`guild/extra${i}`)()
      expect(() => reserve('guild/last')).toThrow('budget')
      clock.mockReturnValue(4_600_000)
      reserve('guild/user1')()
    } finally {
      clock.mockRestore()
    }
  })
  it('rejects oversized generated images before decoding', () => {
    expect(() => decodeRoleChatImage('A'.repeat(14 * 1024 * 1024))).toThrow('Invalid')
    expect(() => decodeRoleChatImage(null)).toThrow('Invalid')
  })
  it.each(['고양이 그려줘', '사진 생성해줘', '이미지 만들어줘', 'create an image', 'draw a cat'])(
    'recognizes image creation requests: %s',
    (prompt) => {
      expect(requestsRoleChatImage(prompt, false)).toBe(true)
    }
  )
  it('allows edits with a supplied image without mistaking text correction for image edits', () => {
    expect(requestsRoleChatImage('배경 지워줘', true)).toBe(true)
    expect(requestsRoleChatImage('이 문장 수정해줘', false)).toBe(false)
    expect(requestsRoleChatImage('사진에 뭐라고 써 있어?', true)).toBe(false)
  })
  it.each(['image/png', 'image/jpeg', 'image/webp', 'IMAGE/PNG; charset=binary', null])(
    'accepts supported image attachments (%s) without stripping signed query parameters',
    (contentType) => {
      expect(roleChatImageUrl(file({ contentType }))).toBe(URL)
    }
  )
  it('accepts a verified image MIME type without a filename extension and proxy CDN URLs', () => {
    const url = URL.replace('cdn.discordapp.com', 'media.discordapp.net').replace(
      'photo.png',
      'photo'
    )
    expect(roleChatImageUrl(file({ url }))).toBe(url)
    expect(roleChatImageUrl(file({ url, contentType: null }))).toBeUndefined()
  })
  it.each(['image/svg+xml', 'image/gif', 'application/pdf', 'text/plain'])(
    'rejects unsupported MIME types (%s)',
    (contentType) => {
      expect(roleChatImageUrl(file({ contentType }))).toBeUndefined()
    }
  )
  it.each([0, -1, NaN, Infinity, 10 * 1024 * 1024 + 1])(
    'rejects invalid or oversized files (%s bytes)',
    (size) => {
      expect(roleChatImageUrl(file({ size }))).toBeUndefined()
    }
  )
  it('allows the maximum file size', () => {
    expect(roleChatImageUrl(file({ size: 10 * 1024 * 1024 }))).toBe(URL)
  })
  it.each([
    'http://cdn.discordapp.com/attachments/777777777777777777/888888888888888888/photo.png',
    'https://127.0.0.1/photo.png',
    'https://169.254.169.254/photo.png',
    'https://cdn.discordapp.com.evil.example/attachments/777777777777777777/888888888888888888/photo.png',
    'https://evil.example/photo.png',
    'file:///photo.png',
    'not a URL',
    URL.replace('cdn.discordapp.com', 'user:password@cdn.discordapp.com'),
    URL.replace('cdn.discordapp.com', 'cdn.discordapp.com:8443'),
    URL.replace('/attachments/', '/redirect/'),
    URL + '#fragment',
    URL + '&padding=' + 'x'.repeat(2048),
    'https://cdn.discordapp.com/attachments/777777777777777777/888888888888888888/../photo.png'
  ])('never supplies arbitrary or non-attachment URLs as image inputs (%s)', (url) => {
    expect(roleChatImageUrl(file({ url }))).toBeUndefined()
  })
  it('bounds and deduplicates selected images in the supplied relevance order', () => {
    const first = message('1000000000000000100', [file()])
    const second = message('1000000000000000099', [
      file(),
      file({ url: URL.replace('photo.png', 'other.png') })
    ])
    expect(collectRoleChatImages([first, second], 2)).toEqual([
      { url: URL, authorId: first.author.id, messageId: first.id },
      {
        url: URL.replace('photo.png', 'other.png'),
        authorId: second.author.id,
        messageId: second.id
      }
    ])
    const many = message(
      '1000000000000000100',
      Array.from({ length: 20 }, (_, i) =>
        file({ url: URL.replace('photo.png', `photo-${i}.png`) })
      )
    )
    expect(collectRoleChatImages([many], 100)).toHaveLength(8)
    expect(collectRoleChatImages([many], 0)).toEqual([])
    expect(collectRoleChatImages([many], NaN)).toEqual([])
  })
})
