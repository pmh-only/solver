import { createCanvas, loadImage } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { drawCanvasText, renderVisualCard, wrapCanvasText } from '../canvas.js'

describe('canvas presentation', () => {
  it('renders a compact visual-only PNG', async () => {
    const png = renderVisualCard({ kind: 'dice', value: 4 })
    const image = await loadImage(png)
    const pixels = createCanvas(image.width, image.height)
    const ctx = pixels.getContext('2d')
    ctx.drawImage(image, 0, 0)

    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(image.width).toBeLessThan(824)
    expect(image.height).toBe(216)
    expect(ctx.getImageData(0, 0, 1, 1).data[3]).toBe(0)
  })

  it('draws Tic-Tac-Toe board state without horizontal spacing', async () => {
    const empty = renderVisualCard({ kind: 'ttt', board: Array(9).fill(null) })
    const played = renderVisualCard({
      kind: 'ttt',
      board: ['X', 'O', null, null, null, null, null, null, null]
    })
    const image = await loadImage(played)
    const pixels = createCanvas(image.width, image.height)
    const ctx = pixels.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const edgeHasOpaquePixel = (x: number) => {
      const data = ctx.getImageData(x, 0, 1, image.height).data
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) return true
      }
      return false
    }

    expect(played).not.toEqual(empty)
    expect(image.width).toBeLessThan(400)
    expect(edgeHasOpaquePixel(0)).toBe(true)
    expect(edgeHasOpaquePixel(image.width - 1)).toBe(true)
  })

  it('renders a complete chess board and highlights selected squares', async () => {
    const board = Array.from({ length: 8 }, () => Array(8).fill(null))
    board[0][4] = { square: 'e8', type: 'k', color: 'b' }
    board[7][4] = { square: 'e1', type: 'k', color: 'w' }
    const plain = renderVisualCard({ kind: 'chess', board })
    const selected = renderVisualCard({ kind: 'chess', board, selected: 'e1' })
    const image = await loadImage(selected)

    expect(image.width).toBeGreaterThan(540)
    expect(image.height).toBe(560)
    expect(selected).not.toEqual(plain)
  })

  it('renders six distinct chess piece silhouettes without symbol fonts', () => {
    const pieceTypes = ['p', 'n', 'b', 'r', 'q', 'k'] as const
    const images = pieceTypes.map((type) => {
      const board = Array.from({ length: 8 }, () => Array(8).fill(null))
      board[4][4] = { square: 'e4', type, color: 'w' }
      return renderVisualCard({ kind: 'chess', board }).toString('base64')
    })

    expect(new Set(images).size).toBe(pieceTypes.length)
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

  it('renders emoji with local Twemoji artwork', () => {
    const canvas = createCanvas(64, 64)
    const ctx = canvas.getContext('2d')
    ctx.font = '48px sans-serif'
    ctx.textBaseline = 'top'
    drawCanvasText(ctx, '🍒', 8, 8)

    const pixels = ctx.getImageData(0, 0, 64, 64).data
    let redPixels = 0
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 150 && pixels[index + 1] < 100 && pixels[index + 3] > 0) redPixels++
    }
    expect(redPixels).toBeGreaterThan(20)
  })
})
