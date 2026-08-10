import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readWebAsset(name: string): string {
  return readFileSync(join(process.cwd(), 'assets', 'web', name), 'utf8')
}

export const WEB_HTML = readWebAsset('index.html')
export const WEB_CSS = readWebAsset('app.css')
export const WEB_MARKDOWN_JS = readWebAsset('markdown.js')
export const WEB_JS = readWebAsset('app.js')
