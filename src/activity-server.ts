import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '0.0.0.0'

const ACTIVITY_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>Hello World Activity</title>
    <style>
      :root {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #f7f8ff;
        background: #0e1020;
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        overflow: hidden;
        background:
          radial-gradient(circle at 18% 22%, rgba(88, 101, 242, 0.42), transparent 34rem),
          radial-gradient(circle at 82% 78%, rgba(235, 69, 158, 0.28), transparent 30rem),
          #0e1020;
      }
      main {
        width: min(42rem, calc(100vw - 2rem));
        padding: clamp(2rem, 8vw, 5rem);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 2rem;
        text-align: center;
        background: rgba(20, 23, 45, 0.76);
        box-shadow: 0 2rem 6rem rgba(0, 0, 0, 0.42);
        backdrop-filter: blur(1.25rem);
      }
      p {
        margin: 0 0 1rem;
        color: #aeb5d6;
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: clamp(3rem, 12vw, 7rem);
        line-height: 0.92;
        letter-spacing: -0.065em;
      }
    </style>
  </head>
  <body>
    <main>
      <p>Discord Activity</p>
      <h1>Hello, World!</h1>
    </main>
  </body>
</html>
`

function send(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  headOnly: boolean
): void {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors https://discord.com https://*.discord.com",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(headOnly ? undefined : body)
}

export function handleActivityRequest(request: IncomingMessage, response: ServerResponse): void {
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    send(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed\n', false)
    return
  }

  let pathname: string
  try {
    pathname = new URL(request.url ?? '/', 'http://activity.local').pathname
  } catch {
    send(response, 400, 'text/plain; charset=utf-8', 'Bad Request\n', method === 'HEAD')
    return
  }
  if (pathname === '/') {
    send(response, 200, 'text/html; charset=utf-8', ACTIVITY_HTML, method === 'HEAD')
    return
  }
  if (pathname === '/healthz') {
    send(response, 200, 'text/plain; charset=utf-8', 'ok\n', method === 'HEAD')
    return
  }
  send(response, 404, 'text/plain; charset=utf-8', 'Not Found\n', method === 'HEAD')
}

export function createActivityServer(): Server {
  const server = createServer(handleActivityRequest)
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 100
  server.maxRequestsPerSocket = 100
  return server
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }
  return port
}

export async function startActivityServer(
  options: {
    host?: string
    port?: number
  } = {}
): Promise<Server> {
  const host = options.host ?? process.env.ACTIVITY_HOST ?? DEFAULT_HOST
  const port = options.port ?? parsePort(process.env.PORT)
  const server = createActivityServer()

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

  return server
}

export async function closeActivityServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
