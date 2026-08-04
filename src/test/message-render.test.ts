import { describe, expect, it } from 'vitest'
import { formatMessageContentLine } from '../commands/message-render.js'

describe('message render markdown presentation', () => {
  it('renders Discord subtext without its marker', () => {
    expect(formatMessageContentLine('-# Secondary detail')).toEqual({
      text: 'Secondary detail',
      style: 'subtext'
    })
  })

  it('turns unordered and task list markers into visible list glyphs', () => {
    expect(formatMessageContentLine('- First item')).toEqual({
      text: '• First item',
      style: 'body'
    })
    expect(formatMessageContentLine('  * [x] Finished')).toEqual({
      text: '  ☑ Finished',
      style: 'body'
    })
    expect(formatMessageContentLine('+ [ ] Remaining')).toEqual({
      text: '☐ Remaining',
      style: 'body'
    })
  })

  it('handles headings, quotes, and dividers with lightweight presentation', () => {
    expect(formatMessageContentLine('## Result')).toEqual({ text: 'Result', style: 'heading' })
    expect(formatMessageContentLine('> Note')).toEqual({ text: '▎ Note', style: 'quote' })
    expect(formatMessageContentLine('---')).toEqual({
      text: '────────────────',
      style: 'subtext'
    })
  })

  it('can preserve markdown-looking text inside fenced code', () => {
    expect(formatMessageContentLine('- literal', false)).toEqual({
      text: '- literal',
      style: 'body'
    })
  })
})
