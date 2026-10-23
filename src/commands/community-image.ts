import { createCanvas, loadImage } from '@napi-rs/canvas'

function dimensions(data: Buffer): [number, number] {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return [data.readUInt32BE(16), data.readUInt32BE(20)]
  }
  if (data.length >= 26 && data.toString('ascii', 0, 2) === 'BM' && data.readUInt32LE(14) >= 40) {
    return [Math.abs(data.readInt32LE(18)), Math.abs(data.readInt32LE(22))]
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) break
      const marker = data[offset + 1]!
      if (marker === 0xff) {
        offset++
        continue
      }
      const length = data.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > data.length) break
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) {
        return [data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5)]
      }
      offset += length + 2
    }
  }
  throw new Error('PNG, JPEG, BMP 이미지만 지원합니다.')
}

let activeImages = 0

export async function normalizeEmojiImage(data: Buffer): Promise<Buffer> {
  if (activeImages >= 2)
    throw new Error('이미지 처리 요청이 너무 많습니다. 잠시 후 다시 시도하세요.')
  activeImages++
  try {
    return await resizeEmojiImage(data)
  } finally {
    activeImages--
  }
}

async function resizeEmojiImage(data: Buffer): Promise<Buffer> {
  if (data.length > 1024 * 1024) throw new Error('이미지는 1 MiB 이하만 지원합니다.')
  const [width, height] = dimensions(data)
  if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 16_000_000)
    throw new Error('이미지 크기가 너무 큽니다 (최대 4096px / 16MP).')
  const image = await loadImage(data)
  if (image.width !== width || image.height !== height) throw new Error('잘못된 이미지 크기입니다.')
  const scale = Math.min(128 / width, 128 / height, 1)
  const canvas = createCanvas(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale))
  )
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  const output = await canvas.encode('png')
  if (output.length > 256 * 1024) throw new Error('이모지 용량이 너무 큽니다.')
  return output
}
