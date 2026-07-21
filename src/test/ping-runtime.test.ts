import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { parseIcmpTimes, probePingTarget } from '../ping-runtime.js'

let server: Server | undefined

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
})

describe('ping runtime', () => {
  it('parses ordinary and sub-millisecond ICMP replies', () => {
    const output = [
      '64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=1.25 ms',
      '64 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time<1 ms'
    ].join('\n')

    expect(parseIcmpTimes(output)).toEqual([1.25, 0.5])
  })

  it('runs HTTP samples sequentially over fresh connections', async () => {
    let active = 0
    let maxActive = 0
    const sockets = new Set<number>()

    server = createServer((request, response) => {
      active++
      maxActive = Math.max(maxActive, active)
      sockets.add(request.socket.remotePort!)
      setTimeout(() => {
        response.end('ok')
        active--
      }, 10)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const report = await probePingTarget({
      host: `http://127.0.0.1:${address.port}`,
      count: 3,
      types: ['http']
    })

    expect(report.summaries[0].ms).toHaveLength(3)
    expect(maxActive).toBe(1)
    expect(sockets.size).toBe(3)
  })
})
