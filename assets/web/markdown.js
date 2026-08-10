const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  )

function md(value) {
  let source = esc(value).replace(/@@CODE\d+@@/g, '')
  const blocks = []
  const tick = String.fromCharCode(96)

  source = source.replace(
    new RegExp(tick + '{3}(?:\\w+)?\\n?([\\s\\S]*?)' + tick + '{3}', 'g'),
    (_, content) => {
      blocks.push('<pre><code>' + content + '</code></pre>')
      return '@@CODE' + (blocks.length - 1) + '@@'
    }
  )
  source = source
    .replace(/^(?:[-*+] [^\n]*(?:\n|$))+/gm, (items) => {
      const trailing = items.endsWith('\n')
      const lines = items.split('\n')
      if (trailing) lines.pop()
      return (
        '<ul>' +
        lines.map((item) => '<li>' + item.slice(2) + '</li>').join('') +
        '</ul>' +
        (trailing ? '\n' : '')
      )
    })
    .replace(/^-# (.*)$/gm, '<small class="subtext">$1</small>')
    .replace(new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'), '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^###? (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(
      /(^|\s)(https?:\/\/[^\s<]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
    )
    .replace(/\n/g, '<br>')

  return source.replace(/@@CODE(\d+)@@/g, (_, index) => blocks[Number(index)])
}
