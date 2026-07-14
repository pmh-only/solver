import { createCanvas, GlobalFonts, Image, type SKRSContext2D } from '@napi-rs/canvas'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GG_SANS_REGULAR = fileURLToPath(new URL('../assets/fonts/gg-sans-400.woff2', import.meta.url))
const GG_SANS_MEDIUM = fileURLToPath(new URL('../assets/fonts/gg-sans-500.woff2', import.meta.url))
const GG_SANS_BOLD = fileURLToPath(new URL('../assets/fonts/gg-sans-700.woff2', import.meta.url))
const NOTO_SANS_CJK_JP = fileURLToPath(
  new URL('../assets/fonts/NotoSansCJKjp-Regular.otf', import.meta.url)
)
const NOTO_SANS_CJK_KR = fileURLToPath(
  new URL('../assets/fonts/NotoSansCJKkr-Regular.otf', import.meta.url)
)
const NOTO_SANS_CJK_SC = fileURLToPath(
  new URL('../assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url)
)
const NOTO_SANS_CJK_TC = fileURLToPath(
  new URL('../assets/fonts/NotoSansCJKtc-Regular.otf', import.meta.url)
)
const TWEMOJI_BASE_URL = new URL('../node_modules/@twemoji/svg/', import.meta.url)
const EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u20E3]/u
const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const twemojiCache = new Map<string, Image | null>()

export const GG_SANS_FAMILY = 'gg sans'
export const KO_FAMILY = 'discord-cjk-ko'
export const JA_FAMILY = 'discord-cjk-ja'
export const ZH_CN_FAMILY = 'discord-cjk-zh-cn'
export const ZH_TW_FAMILY = 'discord-cjk-zh-tw'

export type LocaleKind = 'ko' | 'ja' | 'zh-CN' | 'zh-TW' | 'default'

export interface VisualCard {
  title: string
  kicker: string
  lines: string[]
  accent: number
  footer?: string
  visual?: CardVisual
}

export type CardVisual =
  | { kind: 'ttt'; board: Array<'X' | 'O' | null>; winner?: 'X' | 'O' }
  | { kind: 'coin'; side?: 'heads' | 'tails' }
  | { kind: 'dice'; value?: number }
  | { kind: 'slots'; symbols?: string[] }
  | { kind: 'rps'; choices?: [string, string]; labels?: [string, string] }
  | { kind: 'hilo'; current: number; previous?: number }
  | {
      kind: 'blackjack'
      player: Array<{ rank: string; suit: string }>
      dealer: Array<{ rank: string; suit: string; hidden?: boolean }>
    }
  | { kind: 'memory'; cells: Array<string | null>; matched: number[] }
  | { kind: 'quiz'; options: string[]; selected?: number; correct?: number }
  | { kind: 'poll'; options: Array<{ label: string; count: number; percent: number }> }

function registerFont(path: string, family: string) {
  GlobalFonts.registerFromPath(path, family)
}

registerFont(GG_SANS_REGULAR, GG_SANS_FAMILY)
registerFont(GG_SANS_MEDIUM, GG_SANS_FAMILY)
registerFont(GG_SANS_BOLD, GG_SANS_FAMILY)
registerFont(NOTO_SANS_CJK_KR, KO_FAMILY)
registerFont(NOTO_SANS_CJK_JP, JA_FAMILY)
registerFont(NOTO_SANS_CJK_SC, ZH_CN_FAMILY)
registerFont(NOTO_SANS_CJK_TC, ZH_TW_FAMILY)

export function detectLocale(locale: string, value: string): LocaleKind {
  if (/[\uac00-\ud7af]/u.test(value)) return 'ko'
  if (/[\u3040-\u30ff]/u.test(value)) return 'ja'
  if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(value)) {
    return locale.startsWith('zh-TW') || locale.startsWith('zh-HK') ? 'zh-TW' : 'zh-CN'
  }
  if (locale.startsWith('ko')) return 'ko'
  if (locale.startsWith('ja')) return 'ja'
  if (locale.startsWith('zh-TW') || locale.startsWith('zh-HK')) return 'zh-TW'
  if (locale.startsWith('zh')) return 'zh-CN'
  return 'default'
}

export function fontFamilyForLocale(locale: LocaleKind) {
  switch (locale) {
    case 'ko':
      return KO_FAMILY
    case 'ja':
      return JA_FAMILY
    case 'zh-CN':
      return ZH_CN_FAMILY
    case 'zh-TW':
      return ZH_TW_FAMILY
    default:
      return GG_SANS_FAMILY
  }
}

export function fontFamilyForText(value: string, locale: LocaleKind) {
  if (/[\uac00-\ud7af]/u.test(value)) return KO_FAMILY
  if (/[\u3040-\u30ff]/u.test(value)) return JA_FAMILY
  if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(value)) {
    if (locale === 'zh-TW') return ZH_TW_FAMILY
    if (locale === 'zh-CN') return ZH_CN_FAMILY
    return JA_FAMILY
  }
  return fontFamilyForLocale(locale)
}

export function setCanvasFont(
  ctx: SKRSContext2D,
  weight: 400 | 500 | 700,
  size: number,
  family: string
) {
  ctx.font = `${weight} ${size}px "${family}"`
}

function graphemes(value: string) {
  return [...graphemeSegmenter.segment(value)].map((entry) => entry.segment)
}

function twemojiCodePoints(value: string) {
  const points = [...value].map((character) => character.codePointAt(0)!.toString(16))
  const stripped = points.filter((point) => point !== 'fe0f').join('-')
  const raw = points.join('-')
  return stripped === raw ? [raw] : [stripped, raw]
}

function twemojiImage(value: string): Image | null {
  if (!EMOJI_PATTERN.test(value)) return null
  const cached = twemojiCache.get(value)
  if (cached !== undefined) return cached

  for (const codePoint of twemojiCodePoints(value)) {
    try {
      const image = new Image(36, 36)
      image.src = readFileSync(new URL(`${codePoint}.svg`, TWEMOJI_BASE_URL))
      if (image.complete) {
        twemojiCache.set(value, image)
        return image
      }
    } catch {
      // Try the next Twemoji filename variant before falling back to text.
    }
  }

  twemojiCache.set(value, null)
  return null
}

function canvasFontSize(ctx: SKRSContext2D) {
  return Number.parseFloat(ctx.font.match(/([\d.]+)px/)?.[1] ?? '16')
}

function canvasTextRuns(ctx: SKRSContext2D, value: string) {
  const runs: Array<{ text: string; image: Image | null; width: number }> = []
  let text = ''
  const flushText = () => {
    if (!text) return
    runs.push({ text, image: null, width: ctx.measureText(text).width })
    text = ''
  }

  for (const grapheme of graphemes(value)) {
    const image = twemojiImage(grapheme)
    if (!image) {
      text += grapheme
      continue
    }
    flushText()
    runs.push({ text: grapheme, image, width: canvasFontSize(ctx) })
  }
  flushText()
  return runs
}

export function measureCanvasText(ctx: SKRSContext2D, value: string) {
  return canvasTextRuns(ctx, value).reduce((width, run) => width + run.width, 0)
}

export function drawCanvasText(ctx: SKRSContext2D, value: string, x: number, y: number) {
  const runs = canvasTextRuns(ctx, value)
  const width = runs.reduce((sum, run) => sum + run.width, 0)
  const originalAlign = ctx.textAlign
  let cursor =
    originalAlign === 'center'
      ? x - width / 2
      : originalAlign === 'right' || originalAlign === 'end'
        ? x - width
        : x
  const size = canvasFontSize(ctx)
  const imageY =
    ctx.textBaseline === 'top' || ctx.textBaseline === 'hanging'
      ? y
      : ctx.textBaseline === 'middle'
        ? y - size / 2
        : ctx.textBaseline === 'bottom' || ctx.textBaseline === 'ideographic'
          ? y - size
          : y - size * 0.82

  ctx.textAlign = 'left'
  for (const run of runs) {
    if (run.image) {
      ctx.drawImage(run.image, cursor, imageY, size, size)
    } else {
      ctx.fillText(run.text, cursor, y)
    }
    cursor += run.width
  }
  ctx.textAlign = originalAlign
}

export function wrapCanvasText(ctx: SKRSContext2D, value: string, maxWidth: number) {
  const lines: string[] = []
  for (const paragraph of value.split(/\r?\n/)) {
    if (!paragraph.trim()) {
      lines.push('')
      continue
    }

    let current = ''
    for (const token of paragraph.match(/\s+|\S+/g) ?? []) {
      const candidate = `${current}${token}`
      if (measureCanvasText(ctx, candidate) <= maxWidth) {
        current = candidate
        continue
      }

      if (current) lines.push(current.trimEnd())
      current = current ? token.trimStart() : token
      while (measureCanvasText(ctx, current) > maxWidth && current.length > 1) {
        const chars = graphemes(current)
        let splitIndex = chars.length - 1
        while (
          splitIndex > 1 &&
          measureCanvasText(ctx, chars.slice(0, splitIndex).join('')) > maxWidth
        ) {
          splitIndex--
        }
        lines.push(chars.slice(0, splitIndex).join(''))
        current = chars.slice(splitIndex).join('')
      }
    }
    if (current) lines.push(current.trimEnd())
  }
  return lines.length > 0 ? lines : ['']
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, radius)
}

function fillRoundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string
) {
  roundRect(ctx, x, y, width, height, radius)
  ctx.fillStyle = color
  ctx.fill()
}

function accentHex(accent: number) {
  return `#${accent.toString(16).padStart(6, '0').slice(-6)}`
}

function cleanMarkdown(value: string) {
  return value
    .replace(/^\s*```\w*\s*$/g, '')
    .replace(/^\s*#{1,6}\s+/g, '')
    .replace(/^\s*>\s?/g, '')
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim()
}

function fitText(ctx: SKRSContext2D, value: string, width: number) {
  if (measureCanvasText(ctx, value) <= width) return value
  const next = graphemes(value)
  while (next.length > 1 && measureCanvasText(ctx, `${next.join('')}...`) > width) {
    next.pop()
  }
  return `${next.join('')}...`
}

function visualHeight(visual: CardVisual | undefined) {
  if (!visual) return 0
  if (visual.kind === 'ttt') return 390
  if (visual.kind === 'memory') return 420
  if (visual.kind === 'blackjack') return 290
  if (visual.kind === 'quiz') return 82 + visual.options.length * 58
  if (visual.kind === 'poll') return 60 + Math.min(visual.options.length, 10) * 54
  return 230
}

function drawTtt(ctx: SKRSContext2D, visual: Extract<CardVisual, { kind: 'ttt' }>, y: number) {
  const size = 342
  const x = (920 - size) / 2
  const cell = size / 3

  ctx.lineCap = 'round'
  ctx.lineWidth = 5
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.65)'
  for (let index = 1; index < 3; index++) {
    ctx.beginPath()
    ctx.moveTo(x + cell * index, y + 18)
    ctx.lineTo(x + cell * index, y + size + 18)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x, y + 18 + cell * index)
    ctx.lineTo(x + size, y + 18 + cell * index)
    ctx.stroke()
  }

  visual.board.forEach((mark, index) => {
    const column = index % 3
    const row = Math.floor(index / 3)
    const centerX = x + column * cell + cell / 2
    const centerY = y + 18 + row * cell + cell / 2
    if (!mark) {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#475569'
      setCanvasFont(ctx, 500, 22, GG_SANS_FAMILY)
      drawCanvasText(ctx, `${index + 1}`, centerX, centerY)
      return
    }

    ctx.lineWidth = 13
    ctx.strokeStyle = mark === 'X' ? '#60a5fa' : '#fb7185'
    if (mark === 'X') {
      const inset = 31
      ctx.beginPath()
      ctx.moveTo(centerX - inset, centerY - inset)
      ctx.lineTo(centerX + inset, centerY + inset)
      ctx.moveTo(centerX + inset, centerY - inset)
      ctx.lineTo(centerX - inset, centerY + inset)
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.arc(centerX, centerY, 39, 0, Math.PI * 2)
      ctx.stroke()
    }
  })
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawCoin(ctx: SKRSContext2D, visual: Extract<CardVisual, { kind: 'coin' }>, y: number) {
  const centerX = 460
  const centerY = y + 108
  const gradient = ctx.createRadialGradient(centerX - 32, centerY - 38, 4, centerX, centerY, 100)
  gradient.addColorStop(0, '#fde68a')
  gradient.addColorStop(0.56, '#f59e0b')
  gradient.addColorStop(1, '#92400e')
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(centerX, centerY, 96, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineWidth = 8
  ctx.strokeStyle = '#fef3c7'
  ctx.stroke()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#451a03'
  setCanvasFont(ctx, 700, visual.side ? 62 : 52, GG_SANS_FAMILY)
  drawCanvasText(
    ctx,
    visual.side === 'heads' ? 'H' : visual.side === 'tails' ? 'T' : '?',
    centerX,
    centerY
  )
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

const DICE_PIPS: Record<number, Array<[number, number]>> = {
  1: [[1, 1]],
  2: [
    [0, 0],
    [2, 2]
  ],
  3: [
    [0, 0],
    [1, 1],
    [2, 2]
  ],
  4: [
    [0, 0],
    [2, 0],
    [0, 2],
    [2, 2]
  ],
  5: [
    [0, 0],
    [2, 0],
    [1, 1],
    [0, 2],
    [2, 2]
  ],
  6: [
    [0, 0],
    [2, 0],
    [0, 1],
    [2, 1],
    [0, 2],
    [2, 2]
  ]
}

function drawDice(ctx: SKRSContext2D, visual: Extract<CardVisual, { kind: 'dice' }>, y: number) {
  const size = 188
  const x = (920 - size) / 2
  fillRoundRect(ctx, x, y + 14, size, size, 34, '#f8fafc')
  ctx.shadowColor = 'rgba(15, 23, 42, 0.45)'
  ctx.shadowBlur = 28
  const pips = visual.value ? (DICE_PIPS[visual.value] ?? []) : []
  if (pips.length === 0) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#64748b'
    setCanvasFont(ctx, 700, 64, GG_SANS_FAMILY)
    drawCanvasText(ctx, '?', 460, y + 108)
  } else {
    for (const [column, row] of pips) {
      ctx.fillStyle = '#0f172a'
      ctx.beginPath()
      ctx.arc(x + 46 + column * 48, y + 60 + row * 48, 13, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.shadowBlur = 0
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawSlots(ctx: SKRSContext2D, visual: Extract<CardVisual, { kind: 'slots' }>, y: number) {
  const symbols = visual.symbols ?? ['?', '?', '?']
  const reelWidth = 208
  const gap = 20
  const startX = (920 - reelWidth * 3 - gap * 2) / 2
  symbols.slice(0, 3).forEach((symbol, index) => {
    const x = startX + index * (reelWidth + gap)
    fillRoundRect(ctx, x, y + 24, reelWidth, 170, 24, '#f8fafc')
    fillRoundRect(ctx, x + 14, y + 38, reelWidth - 28, 142, 17, '#e2e8f0')
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#0f172a'
    setCanvasFont(ctx, 700, 72, GG_SANS_FAMILY)
    drawCanvasText(ctx, symbol, x + reelWidth / 2, y + 109)
  })
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawRps(ctx: SKRSContext2D, visual: Extract<CardVisual, { kind: 'rps' }>, y: number) {
  const choices = visual.choices ?? ['READY', 'READY']
  const labels = visual.labels ?? ['PLAYER', 'OPPONENT']
  choices.forEach((choice, index) => {
    const x = index === 0 ? 116 : 484
    fillRoundRect(ctx, x, y + 22, 320, 170, 24, 'rgba(15, 23, 42, 0.72)')
    ctx.textAlign = 'center'
    ctx.fillStyle = '#94a3b8'
    setCanvasFont(ctx, 700, 13, GG_SANS_FAMILY)
    drawCanvasText(ctx, labels[index].toUpperCase(), x + 160, y + 69)
    ctx.fillStyle = '#f8fafc'
    setCanvasFont(ctx, 700, 35, GG_SANS_FAMILY)
    drawCanvasText(ctx, choice.toUpperCase(), x + 160, y + 132)
  })
  ctx.fillStyle = '#64748b'
  setCanvasFont(ctx, 700, 22, GG_SANS_FAMILY)
  drawCanvasText(ctx, 'VS', 460, y + 116)
  ctx.textAlign = 'left'
}

function drawHilo(ctx: SKRSContext2D, visual: Extract<CardVisual, { kind: 'hilo' }>, y: number) {
  const values =
    visual.previous === undefined ? [visual.current] : [visual.previous, visual.current]
  values.forEach((value, index) => {
    const width = values.length === 1 ? 250 : 220
    const x = values.length === 1 ? 335 : index === 0 ? 210 : 490
    fillRoundRect(ctx, x, y + 18, width, 178, 28, 'rgba(15, 23, 42, 0.72)')
    ctx.textAlign = 'center'
    ctx.fillStyle = '#94a3b8'
    setCanvasFont(ctx, 700, 13, GG_SANS_FAMILY)
    drawCanvasText(
      ctx,
      values.length === 1 ? 'CURRENT' : index === 0 ? 'BEFORE' : 'NEXT',
      x + width / 2,
      y + 66
    )
    ctx.fillStyle = '#f8fafc'
    setCanvasFont(ctx, 700, 72, GG_SANS_FAMILY)
    drawCanvasText(ctx, `${value}`, x + width / 2, y + 143)
  })
  if (values.length === 2) {
    ctx.fillStyle = '#67e8f9'
    setCanvasFont(ctx, 700, 36, GG_SANS_FAMILY)
    drawCanvasText(
      ctx,
      visual.current > values[0] ? '>' : visual.current < values[0] ? '<' : '=',
      460,
      y + 124
    )
  }
  ctx.textAlign = 'left'
}

function drawPlayingCard(
  ctx: SKRSContext2D,
  card: { rank: string; suit: string; hidden?: boolean },
  x: number,
  y: number
) {
  const width = 92
  const height = 132
  fillRoundRect(ctx, x, y, width, height, 14, card.hidden ? '#334155' : '#f8fafc')
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (card.hidden) {
    ctx.strokeStyle = '#64748b'
    ctx.lineWidth = 3
    roundRect(ctx, x + 12, y + 12, width - 24, height - 24, 8)
    ctx.stroke()
    ctx.fillStyle = '#94a3b8'
    setCanvasFont(ctx, 700, 28, GG_SANS_FAMILY)
    drawCanvasText(ctx, '?', x + width / 2, y + height / 2)
  } else {
    const red = card.suit === '♥' || card.suit === '♦'
    ctx.fillStyle = red ? '#e11d48' : '#0f172a'
    setCanvasFont(ctx, 700, 25, GG_SANS_FAMILY)
    drawCanvasText(ctx, card.rank, x + width / 2, y + 45)
    setCanvasFont(ctx, 500, 34, fontFamilyForText(card.suit, 'default'))
    drawCanvasText(ctx, card.suit, x + width / 2, y + 88)
  }
}

function drawBlackjack(
  ctx: SKRSContext2D,
  visual: Extract<CardVisual, { kind: 'blackjack' }>,
  y: number
) {
  const drawHand = (
    cards: Array<{ rank: string; suit: string; hidden?: boolean }>,
    rowY: number,
    label: string
  ) => {
    ctx.fillStyle = '#94a3b8'
    setCanvasFont(ctx, 700, 13, GG_SANS_FAMILY)
    drawCanvasText(ctx, label, 66, rowY + 72)
    cards.slice(0, 7).forEach((card, index) => drawPlayingCard(ctx, card, 170 + index * 101, rowY))
  }
  drawHand(visual.dealer, y + 4, 'DEALER')
  drawHand(visual.player, y + 150, 'PLAYER')
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawMemory(
  ctx: SKRSContext2D,
  visual: Extract<CardVisual, { kind: 'memory' }>,
  y: number
) {
  const size = 78
  const gap = 13
  const boardWidth = size * 4 + gap * 3
  const startX = (920 - boardWidth) / 2
  visual.cells.slice(0, 16).forEach((value, index) => {
    const row = Math.floor(index / 4)
    const column = index % 4
    const x = startX + column * (size + gap)
    const tileY = y + 17 + row * (size + gap)
    const matched = visual.matched.includes(index)
    fillRoundRect(ctx, x, tileY, size, size, 17, value ? '#f8fafc' : '#1e293b')
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = value ? '#0f172a' : '#64748b'
    setCanvasFont(ctx, 700, value ? 48 : 16, GG_SANS_FAMILY)
    drawCanvasText(ctx, value ?? `${index + 1}`, x + size / 2, tileY + size / 2)
    if (matched) {
      ctx.strokeStyle = '#f8fafc'
      ctx.lineWidth = 3
      roundRect(ctx, x + 3, tileY + 3, size - 6, size - 6, 14)
      ctx.stroke()
    }
  })
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawQuiz(ctx: SKRSContext2D, visual: Extract<CardVisual, { kind: 'quiz' }>, y: number) {
  visual.options.forEach((option, index) => {
    const selected = visual.selected === index
    const correct = visual.correct === index
    const color = correct ? '#166534' : selected ? '#9f1239' : 'rgba(15, 23, 42, 0.72)'
    fillRoundRect(ctx, 90, y + 18 + index * 58, 740, 44, 14, color)
    fillRoundRect(
      ctx,
      106,
      y + 28 + index * 58,
      25,
      25,
      8,
      correct ? '#22c55e' : selected ? '#fb7185' : '#334155'
    )
    ctx.fillStyle = '#f8fafc'
    setCanvasFont(ctx, 500, 18, GG_SANS_FAMILY)
    drawCanvasText(
      ctx,
      `${index + 1}. ${fitText(ctx, cleanMarkdown(option), 650)}`,
      148,
      y + 48 + index * 58
    )
  })
}

function drawPoll(ctx: SKRSContext2D, visual: Extract<CardVisual, { kind: 'poll' }>, y: number) {
  visual.options.slice(0, 10).forEach((option, index) => {
    const rowY = y + 14 + index * 54
    fillRoundRect(ctx, 80, rowY, 760, 40, 12, 'rgba(15, 23, 42, 0.72)')
    if (option.percent > 0) {
      fillRoundRect(ctx, 80, rowY, Math.max(16, 760 * (option.percent / 100)), 40, 12, '#3730a3')
    }
    ctx.fillStyle = '#f8fafc'
    setCanvasFont(ctx, 500, 17, GG_SANS_FAMILY)
    drawCanvasText(ctx, `${index + 1}. ${fitText(ctx, option.label, 575)}`, 98, rowY + 26)
    ctx.textAlign = 'right'
    drawCanvasText(ctx, `${option.count} / ${option.percent}%`, 822, rowY + 26)
    ctx.textAlign = 'left'
  })
}

function drawVisual(ctx: SKRSContext2D, visual: CardVisual, y: number) {
  if (visual.kind === 'ttt') drawTtt(ctx, visual, y)
  else if (visual.kind === 'coin') drawCoin(ctx, visual, y)
  else if (visual.kind === 'dice') drawDice(ctx, visual, y)
  else if (visual.kind === 'slots') drawSlots(ctx, visual, y)
  else if (visual.kind === 'rps') drawRps(ctx, visual, y)
  else if (visual.kind === 'hilo') drawHilo(ctx, visual, y)
  else if (visual.kind === 'blackjack') drawBlackjack(ctx, visual, y)
  else if (visual.kind === 'memory') drawMemory(ctx, visual, y)
  else if (visual.kind === 'quiz') drawQuiz(ctx, visual, y)
  else drawPoll(ctx, visual, y)
}

export function renderVisualCard(card: VisualCard): Buffer {
  const width = 920
  const padding = 48
  const cropTop = 40
  const locale = detectLocale('en-US', [card.title, ...card.lines].join('\n'))
  const measureCanvas = createCanvas(width, 200)
  const measure = measureCanvas.getContext('2d')
  setCanvasFont(measure, 400, 19, fontFamilyForText(card.lines.join('\n'), locale))

  const sourceLines = card.lines.flatMap((line) => {
    const cleaned = cleanMarkdown(line)
    return cleaned ? wrapCanvasText(measure, cleaned, width - padding * 2) : ['']
  })
  const maxBodyLines = card.visual ? 8 : 16
  const clipped = sourceLines.length > maxBodyLines
  const bodyLines = sourceLines.slice(0, maxBodyLines)
  if (clipped && bodyLines.length > 0) bodyLines[bodyLines.length - 1] = `${bodyLines.at(-1)} ...`

  const visualSize = visualHeight(card.visual)
  const bodyHeight = Math.max(27, bodyLines.length * 27)
  const visualGap = card.visual ? 20 : 0
  const bodyY = 138 + visualSize + visualGap
  const footerHeight = card.footer ? 36 : 0
  const height = bodyY + bodyHeight + footerHeight
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const accent = accentHex(card.accent)

  ctx.fillStyle = accent
  setCanvasFont(ctx, 700, 13, GG_SANS_FAMILY)
  drawCanvasText(ctx, card.kicker.toUpperCase(), padding, 55)
  ctx.fillStyle = '#f8fafc'
  setCanvasFont(ctx, 700, 38, fontFamilyForText(card.title, locale))
  drawCanvasText(ctx, fitText(ctx, cleanMarkdown(card.title), width - padding * 2), padding, 103)

  if (card.visual) drawVisual(ctx, card.visual, 128)

  ctx.fillStyle = '#cbd5e1'
  ctx.textBaseline = 'top'
  bodyLines.forEach((line, index) => {
    setCanvasFont(ctx, 400, 19, fontFamilyForText(line, locale))
    drawCanvasText(ctx, line || ' ', padding, bodyY + index * 27)
  })

  if (card.footer) {
    ctx.fillStyle = '#64748b'
    setCanvasFont(ctx, 500, 14, GG_SANS_FAMILY)
    drawCanvasText(
      ctx,
      fitText(ctx, card.footer, width - padding * 2),
      padding,
      bodyY + bodyHeight + 10
    )
  }

  const output = createCanvas(width - padding * 2, height - cropTop)
  output
    .getContext('2d')
    .drawImage(
      canvas,
      padding,
      cropTop,
      width - padding * 2,
      height - cropTop,
      0,
      0,
      width - padding * 2,
      height - cropTop
    )
  return output.encodeSync('png')
}
