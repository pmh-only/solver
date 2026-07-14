import { createCanvas, loadImage } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { renderVisualCard, wrapCanvasText } from '../canvas.js'

describe('canvas presentation', () => {
  it('renders a decodable command card PNG', async () => {
    const png = renderVisualCard({
      title: 'Math result',
      kicker: 'math / solver',
      lines: ['Expression: 9 * 9', 'Result: 81'],
      accent: 0x06b6d4,
      footer: 'math 9*9'
    })
    const image = await loadImage(png)

    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(image.width).toBe(920)
    expect(image.height).toBeGreaterThan(200)
  })

  it('draws Tic-Tac-Toe board state into the image', () => {
    const empty = renderVisualCard({
      title: 'Tic tac toe',
      kicker: 'Player vs PC',
      lines: ['Your turn.'],
      accent: 0x4f46e5,
      visual: { kind: 'ttt', board: Array(9).fill(null) }
    })
    const played = renderVisualCard({
      title: 'Tic tac toe',
      kicker: 'Player vs PC',
      lines: ['Your turn.'],
      accent: 0x4f46e5,
      visual: { kind: 'ttt', board: ['X', 'O', null, null, null, null, null, null, null] }
    })

    expect(played).not.toEqual(empty)
    expect(played.length).toBeGreaterThan(10_000)
  })

  it('wraps long unbroken command values within the card width', () => {
    const ctx = createCanvas(300, 100).getContext('2d')
    ctx.font = '16px sans-serif'
    const value = 'a'.repeat(200)
    const lines = wrapCanvasText(ctx, value, 120)

    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join('')).toBe(value)
    expect(lines.every((line) => ctx.measureText(line).width <= 120)).toBe(true)
  })
})
