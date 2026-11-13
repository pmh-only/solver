async function readUpdates(response, onUpdate, onChunk) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (value?.length) onChunk?.(value)
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (line.trim()) await onUpdate(JSON.parse(line))
      }
      if (done) {
        if (buffer.trim()) await onUpdate(JSON.parse(buffer))
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
}
