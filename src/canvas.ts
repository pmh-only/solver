import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas'
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
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate
        continue
      }

      if (current) lines.push(current.trimEnd())
      current = current ? token.trimStart() : token
      while (ctx.measureText(current).width > maxWidth && current.length > 1) {
        const chars = [...current]
        let splitIndex = chars.length - 1
        while (
          splitIndex > 1 &&
          ctx.measureText(chars.slice(0, splitIndex).join('')).width > maxWidth
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
  if (ctx.measureText(value).width <= width) return value
  let next = value
  while (next.length > 1 && ctx.measureText(`${next}...`).width > width) {
    next = next.slice(0, -1)
  }
  return `${next}...`
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
  fillRoundRect(ctx, x - 18, y, size + 36, size + 36, 28, 'rgba(15, 23, 42, 0.72)')

  ctx.lineCap = 'round'
  ctx.lineWidth = 5
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)'
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
      ctx.fillText(`${index + 1}`, centerX, centerY)
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
  ctx.fillText(
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
    ctx.fillText('?', 460, y + 108)
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

const SLOT_LABELS = new Map([
  ['🍒', 'CHERRY'],
  ['🍋', 'LEMON'],
  ['🍉', 'MELON'],
  ['⭐', 'STAR'],
  ['🔔', 'BELL']
])

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
    setCanvasFont(ctx, 700, 26, GG_SANS_FAMILY)
    ctx.fillText(SLOT_LABELS.get(symbol) ?? symbol, x + reelWidth / 2, y + 109)
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
    ctx.fillText(labels[index].toUpperCase(), x + 160, y + 69)
    ctx.fillStyle = '#f8fafc'
    setCanvasFont(ctx, 700, 35, GG_SANS_FAMILY)
    ctx.fillText(choice.toUpperCase(), x + 160, y + 132)
  })
  ctx.fillStyle = '#64748b'
  setCanvasFont(ctx, 700, 22, GG_SANS_FAMILY)
  ctx.fillText('VS', 460, y + 116)
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
    ctx.fillText(
      values.length === 1 ? 'CURRENT' : index === 0 ? 'BEFORE' : 'NEXT',
      x + width / 2,
      y + 66
    )
    ctx.fillStyle = '#f8fafc'
    setCanvasFont(ctx, 700, 72, GG_SANS_FAMILY)
    ctx.fillText(`${value}`, x + width / 2, y + 143)
  })
  if (values.length === 2) {
    ctx.fillStyle = '#67e8f9'
    setCanvasFont(ctx, 700, 36, GG_SANS_FAMILY)
    ctx.fillText(
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
    ctx.fillText('?', x + width / 2, y + height / 2)
  } else {
    const red = card.suit === '♥' || card.suit === '♦'
    ctx.fillStyle = red ? '#e11d48' : '#0f172a'
    setCanvasFont(ctx, 700, 25, GG_SANS_FAMILY)
    ctx.fillText(card.rank, x + width / 2, y + 45)
    setCanvasFont(ctx, 500, 34, fontFamilyForText(card.suit, 'default'))
    ctx.fillText(card.suit, x + width / 2, y + 88)
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
    ctx.fillText(label, 66, rowY + 72)
    cards.slice(0, 7).forEach((card, index) => drawPlayingCard(ctx, card, 170 + index * 101, rowY))
  }
  drawHand(visual.dealer, y + 4, 'DEALER')
  drawHand(visual.player, y + 150, 'PLAYER')
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

const MEMORY_LABELS = new Map([
  ['🍎', 'AP'],
  ['🍇', 'GR'],
  ['🍊', 'OR'],
  ['🍓', 'ST'],
  ['🥝', 'KI'],
  ['🍍', 'PI'],
  ['🥥', 'CO'],
  ['🍑', 'PE']
])

function tokenColor(value: string) {
  let hash = 0
  for (const character of value) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  const colors = [
    '#38bdf8',
    '#a78bfa',
    '#fb7185',
    '#fbbf24',
    '#34d399',
    '#f472b6',
    '#818cf8',
    '#22d3ee'
  ]
  return colors[hash % colors.length]
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
    fillRoundRect(ctx, x, tileY, size, size, 17, value ? tokenColor(value) : '#1e293b')
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = value ? '#0f172a' : '#64748b'
    setCanvasFont(ctx, 700, value ? 24 : 16, GG_SANS_FAMILY)
    ctx.fillText(
      value ? (MEMORY_LABELS.get(value) ?? value.slice(0, 2)) : `${index + 1}`,
      x + size / 2,
      tileY + size / 2
    )
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
    ctx.fillText(
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
    ctx.fillText(`${index + 1}. ${fitText(ctx, option.label, 575)}`, 98, rowY + 26)
    ctx.textAlign = 'right'
    ctx.fillText(`${option.count} / ${option.percent}%`, 822, rowY + 26)
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
  const locale = detectLocale('en-US', [card.title, ...card.lines].join('\n'))
  const measureCanvas = createCanvas(width, 200)
  const measure = measureCanvas.getContext('2d')
  setCanvasFont(measure, 400, 19, fontFamilyForText(card.lines.join('\n'), locale))

  const sourceLines = card.lines.flatMap((line) => {
    const cleaned = cleanMarkdown(line)
    return cleaned ? wrapCanvasText(measure, cleaned, width - padding * 2 - 48) : ['']
  })
  const maxBodyLines = card.visual ? 8 : 16
  const clipped = sourceLines.length > maxBodyLines
  const bodyLines = sourceLines.slice(0, maxBodyLines)
  if (clipped && bodyLines.length > 0) bodyLines[bodyLines.length - 1] = `${bodyLines.at(-1)} ...`

  const visualSize = visualHeight(card.visual)
  const bodyHeight = Math.max(86, 36 + bodyLines.length * 27)
  const visualGap = card.visual ? 20 : 0
  const bodyY = 138 + visualSize + visualGap
  const height = bodyY + bodyHeight + 74
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const accent = accentHex(card.accent)

  const background = ctx.createLinearGradient(0, 0, width, height)
  background.addColorStop(0, '#0b1020')
  background.addColorStop(0.55, '#111827')
  background.addColorStop(1, '#172033')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)

  const glow = ctx.createRadialGradient(width - 84, 54, 0, width - 84, 54, 330)
  glow.addColorStop(0, `${accent}55`)
  glow.addColorStop(1, `${accent}00`)
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, width, Math.min(height, 430))
  fillRoundRect(ctx, 24, 28, 7, height - 56, 4, accent)

  ctx.fillStyle = accent
  setCanvasFont(ctx, 700, 13, GG_SANS_FAMILY)
  ctx.fillText(card.kicker.toUpperCase(), padding, 55)
  ctx.fillStyle = '#f8fafc'
  setCanvasFont(ctx, 700, 38, fontFamilyForText(card.title, locale))
  ctx.fillText(fitText(ctx, cleanMarkdown(card.title), width - padding * 2), padding, 103)

  if (card.visual) drawVisual(ctx, card.visual, 128)

  fillRoundRect(ctx, padding, bodyY, width - padding * 2, bodyHeight, 22, 'rgba(15, 23, 42, 0.66)')
  ctx.fillStyle = '#cbd5e1'
  ctx.textBaseline = 'top'
  bodyLines.forEach((line, index) => {
    setCanvasFont(ctx, 400, 19, fontFamilyForText(line, locale))
    ctx.fillText(line || ' ', padding + 24, bodyY + 20 + index * 27)
  })

  if (card.footer) {
    ctx.fillStyle = '#64748b'
    setCanvasFont(ctx, 500, 14, GG_SANS_FAMILY)
    ctx.fillText(fitText(ctx, card.footer, width - padding * 2), padding, height - 37)
  }

  return canvas.encodeSync('png')
}
