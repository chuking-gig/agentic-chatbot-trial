import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const DEFAULT_MODEL = 'gemma-4-26b-a4b-it'
const AVAILABLE_MODELS = new Set([
  DEFAULT_MODEL,
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
])
const LOG_DIRECTORY = new URL('./logs/', import.meta.url)
const LOG_FILE = new URL('./logs/chat-activity.jsonl', import.meta.url)

if (existsSync(new URL('.env', import.meta.url))) {
  for (const line of readFileSync(new URL('.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}

async function streamModelStep({ input, instructions, maxOutputTokens = 700, model = DEFAULT_MODEL, stage, emit, record }) {
  const stepId = randomUUID()
  const inputText = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  const callRecord = {
    stage,
    model,
    instructions: redactSecrets(instructions),
    input: redactSecrets(inputText),
    startedAt: new Date().toISOString(),
    status: 'running',
    output: '',
  }
  record.modelCalls.push(callRecord)
  emit({ type: 'step_start', stepId, stage, model, instructions: callRecord.instructions, input: callRecord.input })

  const contents = Array.isArray(input)
    ? input.map(({ role, content }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] }))
    : [{ role: 'user', parts: [{ text: input }] }]
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: instructions }] }, generationConfig: { maxOutputTokens } }),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(`Gemini API ${response.status}: ${data.error?.message || 'The model request failed.'}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let pendingText = ''
    const emitSafeText = text => {
      pendingText += text
      if (pendingText.length > 64) {
        const safeLength = pendingText.length - 64
        emit({ type: 'step_delta', stepId, text: redactSecrets(pendingText.slice(0, safeLength)) })
        pendingText = pendingText.slice(safeLength)
      }
    }
    const parseEvent = block => {
      const dataLines = block.split('\n').filter(line => line.startsWith('data: '))
      for (const line of dataLines) {
        const chunk = JSON.parse(line.slice(6))
        const text = chunk.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || ''
        if (text) {
          callRecord.output += text
          emitSafeText(text)
        }
      }
    }
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() || ''
      blocks.forEach(parseEvent)
      if (done) break
    }
    if (buffer.trim()) parseEvent(buffer)
    if (pendingText) emit({ type: 'step_delta', stepId, text: redactSecrets(pendingText) })
    callRecord.output = redactSecrets(callRecord.output)
    if (!callRecord.output.trim()) throw new Error('The model returned an empty response.')
    callRecord.status = 'complete'
    callRecord.finishedAt = new Date().toISOString()
    emit({ type: 'step_complete', stepId })
    return callRecord.output.trim()
  } catch (error) {
    callRecord.output = redactSecrets(callRecord.output)
    callRecord.status = 'error'
    callRecord.error = redactSecrets(error.message)
    callRecord.finishedAt = new Date().toISOString()
    emit({ type: 'step_error', stepId, error: callRecord.error })
    throw error
  }
}

function redactSecrets(value) {
  let safe = String(value ?? '')
  const apiKey = process.env.GEMINI_API_KEY
  if (apiKey && apiKey.length > 10) safe = safe.replaceAll(apiKey, '[REDACTED_GEMINI_API_KEY]')
  return safe.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_GEMINI_API_KEY]')
}

async function appendActivityLog(record) {
  try {
    await mkdir(LOG_DIRECTORY, { recursive: true })
    await appendFile(LOG_FILE, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (error) {
    console.error('Could not write the local activity log:', error.message)
  }
}

async function handleChat(req, res) {
  let body = ''
  for await (const chunk of req) body += chunk
  let payload
  try { payload = JSON.parse(body) } catch { return sendJson(res, 400, { error: 'Request body must be valid JSON.' }) }
  const { messages } = payload
  if (payload.model && !AVAILABLE_MODELS.has(payload.model)) {
    return sendJson(res, 400, { error: 'Choose a model from the model selector.' })
  }
  const model = payload.model || process.env.GEMINI_MODEL || DEFAULT_MODEL
  const quickTest = payload.quickTest === true
  if (!Array.isArray(messages) || !messages.length || messages.at(-1)?.role !== 'user' || typeof messages.at(-1)?.content !== 'string') {
    return sendJson(res, 400, { error: 'Send a conversation ending with a user message.' })
  }
  const history = messages.slice(-12).map(({ role, content }) => ({ role: role === 'assistant' ? 'assistant' : 'user', content: String(content).slice(0, 6000) }))
  const startedAt = new Date()
  const record = {
    requestId: randomUUID(),
    startedAt: startedAt.toISOString(),
    model,
    mode: quickTest ? 'quick-test' : 'draft-review-refine',
    userMessage: redactSecrets(messages.at(-1).content),
    steps: [],
    modelCalls: [],
  }
  if (!process.env.GEMINI_API_KEY) {
    const error = 'Add your Gemini API key to .env to start chatting.'
    Object.assign(record, { finishedAt: new Date().toISOString(), durationMs: 0, outcome: 'error', error })
    await appendActivityLog(record)
    return sendJson(res, 503, { error })
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  const emit = event => {
    if (event.type === 'status') record.steps.push({ at: new Date().toISOString(), message: event.message })
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  try {
    emit({ type: 'status', message: quickTest ? 'Generating a quick response' : 'Drafting an initial answer' })
    const draft = await streamModelStep({
      input: history,
      instructions: 'You are Refine, a clear, warm, useful assistant. Answer the user directly. Be accurate, say when uncertain, and keep the answer appropriately concise.',
      maxOutputTokens: 700,
      model,
      stage: 'Draft',
      emit,
      record,
    })
    if (quickTest) {
      Object.assign(record, { finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt.getTime(), outcome: 'success', answer: redactSecrets(draft) })
      await appendActivityLog(record)
      emit({ type: 'result', answer: draft, reviewRounds: 0, quickTest: true, trace: record.modelCalls })
      return res.end()
    }
    let answer = draft
    let refinementWarning = ''
    let rounds = 0
    for (; rounds < 2; rounds++) {
      emit({ type: 'status', message: `Reviewing the answer · pass ${rounds + 1}` })
      const review = await streamModelStep({
        input: `User request and conversation:\n${JSON.stringify(history)}\n\nCurrent answer:\n${answer}\n\nReview for correctness, relevance, clarity, and completeness. Return exactly READY if this answer is good enough. Otherwise, return a concise instruction for what to fix.`,
        instructions: 'You are a strict but practical answer reviewer. Do not ask for unnecessary perfection. Your entire response must be either READY or one short actionable improvement.',
        maxOutputTokens: 120,
        model,
        stage: `Review pass ${rounds + 1}`,
        emit,
        record,
      })
      if (/^READY\b/i.test(review)) break
      emit({ type: 'status', message: `Refining the answer · pass ${rounds + 1}` })
      try {
        answer = await streamModelStep({
          input: `Conversation:\n${JSON.stringify(history)}\n\nPrevious answer:\n${answer}\n\nReviewer feedback:\n${review}\n\nReturn the improved final answer.`,
          instructions: 'You are Refine. Improve the answer using the reviewer feedback. Preserve useful parts, correct problems, and respond naturally to the user.',
          maxOutputTokens: 700,
          model,
          stage: `Refinement pass ${rounds + 1}`,
          emit,
          record,
        })
      } catch (error) {
        refinementWarning = `Refinement failed (${error.message}). Showing the best answer produced so far.`
        console.error('Refinement failed; returning the best available answer:', error.message)
        break
      }
    }
    Object.assign(record, {
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      outcome: refinementWarning ? 'partial' : 'success',
      answer: redactSecrets(answer),
      ...(refinementWarning ? { warning: redactSecrets(refinementWarning) } : {}),
      reviewRounds: rounds,
    })
    await appendActivityLog(record)
    emit({ type: 'result', answer, reviewRounds: rounds, quickTest: false, refinementWarning, trace: record.modelCalls })
    res.end()
  } catch (error) {
    console.error('Chat request failed:', error.message)
    const message = redactSecrets(error.message || 'Could not get a response from the model.')
    Object.assign(record, { finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt.getTime(), outcome: 'error', error: message })
    await appendActivityLog(record)
    emit({ type: 'error', error: message })
    res.end()
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

const port = Number(process.env.PORT || 3001)
createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' })
    return res.end()
  }
  if (req.method === 'GET' && req.url === '/api/health') return sendJson(res, 200, { ready: Boolean(process.env.GEMINI_API_KEY) })
  if (req.method === 'POST' && req.url === '/api/chat') return void handleChat(req, res)
  sendJson(res, 404, { error: 'Not found' })
}).listen(port, '127.0.0.1', () => console.log(`Refine API listening on http://localhost:${port}`))
