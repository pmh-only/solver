import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { WEB_MARKDOWN_JS } from '../web-ui.js'

function markdown(value: string): string {
  return runInNewContext(`${WEB_MARKDOWN_JS};md(input)`, { input: value }) as string
}

describe('web UI markdown', () => {
  it('renders Discord subtext without showing the marker', () => {
    expect(markdown('-# Secondary detail')).toBe('<small class="subtext">Secondary detail</small>')
  })

  it('renders contiguous unordered list lines as a list', () => {
    expect(markdown('Items\n- First **item**\n- Second item\nAfter')).toBe(
      'Items<br><ul><li>First <strong>item</strong></li><li>Second item</li></ul><br>After'
    )
  })

  it('leaves list-looking lines inside fenced code unchanged', () => {
    expect(markdown('```text\n- literal\n-# literal subtext\n```')).toBe(
      '<pre><code>- literal\n-# literal subtext\n</code></pre>'
    )
  })
})
