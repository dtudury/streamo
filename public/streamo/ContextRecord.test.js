import { describe } from './utils/testing.js'
import { ContextRecord } from './ContextRecord.js'

// A stub StreamoRecord that just answers .get('messages').
const recordOf = (messages) => ({
  get (key) {
    return key === 'messages' ? messages : undefined
  }
})

describe(import.meta.url, ({ test }) => {
  test('rawMessages passes through the value at messages', ({ assert }) => {
    const msgs = [{ type: 'user', message: { role: 'user', content: 'hi' } }]
    const ctx = new ContextRecord(recordOf(msgs))
    assert.equal(ctx.rawMessages(), msgs)
  })

  test('rawMessages returns [] when value has no messages', ({ assert }) => {
    const ctx = new ContextRecord({ get: () => undefined })
    assert.deepEqual(ctx.rawMessages(), [])
  })

  test('apiMessages extracts text from string content', ({ assert }) => {
    const ctx = new ContextRecord(recordOf([
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hi back' } }
    ]))
    assert.deepEqual(ctx.apiMessages(), [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi back' }
    ])
  })

  test('apiMessages extracts text from block-array content (drops thinking + tool blocks)', ({ assert }) => {
    const ctx = new ContextRecord(recordOf([
      { type: 'assistant', message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'inner monologue' },
          { type: 'text', text: 'visible answer' },
          { type: 'tool_use', id: 'x', name: 'foo', input: {} }
        ]
      }}
    ]))
    assert.deepEqual(ctx.apiMessages(), [
      { role: 'assistant', content: 'visible answer' }
    ])
  })

  test('apiMessages drops sidechain (subagent) traces', ({ assert }) => {
    const ctx = new ContextRecord(recordOf([
      { type: 'user', message: { role: 'user', content: 'a' } },
      { type: 'assistant', message: { role: 'assistant', content: 'b' }, isSidechain: true },
      { type: 'assistant', message: { role: 'assistant', content: 'c' } }
    ]))
    assert.deepEqual(ctx.apiMessages(), [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'c' }
    ])
  })

  test('apiMessages drops non-user/assistant entries (system reminders, hooks, etc.)', ({ assert }) => {
    const ctx = new ContextRecord(recordOf([
      { type: 'last-prompt' },
      { type: 'mode' },
      { type: 'user', message: { role: 'user', content: 'q' } },
      { type: 'permission-mode' }
    ]))
    assert.deepEqual(ctx.apiMessages(), [
      { role: 'user', content: 'q' }
    ])
  })

  test('apiMessages drops messages whose text becomes empty after filtering', ({ assert }) => {
    const ctx = new ContextRecord(recordOf([
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'just thinking' },
        { type: 'tool_use', id: 'x', name: 'foo', input: {} }
      ] } },
      { type: 'user', message: { role: 'user', content: '' } },
      { type: 'user', message: { role: 'user', content: '   \n  ' } },
      { type: 'user', message: { role: 'user', content: 'real' } }
    ]))
    assert.deepEqual(ctx.apiMessages(), [
      { role: 'user', content: 'real' }
    ])
  })

  test('apiMessages collapses consecutive same-role messages (API requirement)', ({ assert }) => {
    const ctx = new ContextRecord(recordOf([
      { type: 'user', message: { role: 'user', content: 'first' } },
      { type: 'user', message: { role: 'user', content: 'second' } },
      { type: 'assistant', message: { role: 'assistant', content: 'reply1' } },
      { type: 'assistant', message: { role: 'assistant', content: 'reply2' } }
    ]))
    assert.deepEqual(ctx.apiMessages(), [
      { role: 'user', content: 'first\n\nsecond' },
      { role: 'assistant', content: 'reply1\n\nreply2' }
    ])
  })

  test('chat throws cleanly when ANTHROPIC_API_KEY is missing', async ({ assert }) => {
    const ctx = new ContextRecord(recordOf([]))
    // Save + restore env
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await assert.rejects(
        () => ctx.chat('hi', { apiKey: undefined }),
        /ANTHROPIC_API_KEY required/
      )
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    }
  })
})
