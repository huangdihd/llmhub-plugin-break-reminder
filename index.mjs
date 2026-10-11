const DEFAULT_MESSAGES = [
  '今天已经写了 {requests} 轮、{tokens} 个 token 了。合上电脑吧,代码明天还在。',
  '到点了。站起来走走,喝口水,{reset} 之后再来。',
  '你今天的额度用完了。不是模型累了,是你该休息了。',
  '今天就到这儿。去睡觉,bug 在梦里不会变多。',
  '已达到今天的上限({tokens} token)。{reset} 重置,在那之前请离开键盘。'
]

function nonnegative(value, fallback = 0) {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) ? Math.max(0, number) : fallback
}

function settings(api) {
  const configuration = api.config
  return {
    dailyTokens: nonnegative(configuration.dailyTokens),
    dailyRequests: nonnegative(configuration.dailyRequests),
    resetHour: Math.min(23, Math.floor(nonnegative(configuration.resetHour, 4))),
    messages: typeof configuration.messages === 'string'
      ? configuration.messages.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      : []
  }
}

function calendar(date, resetHour) {
  const boundary = new Date(date)
  boundary.setHours(resetHour, 0, 0, 0)
  if (date < boundary) {
    boundary.setDate(boundary.getDate() - 1)
    boundary.setHours(resetHour, 0, 0, 0)
  }
  const period = `${boundary.getFullYear()}-${String(boundary.getMonth() + 1).padStart(2, '0')}-${String(boundary.getDate()).padStart(2, '0')}`
  const next = new Date(boundary)
  // Calendar arithmetic preserves local reset times across DST changes.
  next.setDate(next.getDate() + 1)
  next.setHours(resetHour, 0, 0, 0)
  return { period, reset: `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}` }
}

function validState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.period !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.period)) return false
  const date = new Date(`${value.period}T12:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.period) return false
  return Number.isFinite(value.tokens) && value.tokens >= 0
    && Number.isSafeInteger(value.requests) && value.requests >= 0
}

/** @param {object} api The LLMHub plugin API. @param {() => Date} now Injected in tests. */
export async function setup(api, now = () => new Date()) {
  let state = { period: calendar(now(), settings(api).resetHour).period, tokens: 0, requests: 0 }
  let revision = 0
  let persistedRevision = 0
  const stored = await api.storage.getItem('daily')
  if (stored != null) {
    if (validState(stored)) state = { period: stored.period, tokens: stored.tokens, requests: stored.requests }
    else {
      api.logger.warn('Invalid break-reminder daily state; resetting counters.')
      revision++
    }
  }

  let counting = Promise.resolve()
  let writing = null
  let closed = false

  function current(configuration = settings(api), date = now()) {
    const day = calendar(date, configuration.resetHour)
    if (state.period !== day.period) {
      state = { period: day.period, tokens: 0, requests: 0 }
      revision++
    }
    return day
  }

  function flush() {
    if (writing) return writing
    if (revision === persistedRevision) return
    const snapshot = { ...state }
    const savedRevision = revision
    writing = (async () => {
      try {
        await api.storage.setItem('daily', snapshot)
        persistedRevision = savedRevision
      } catch (error) {
        // Keep the revision dirty so the next timer tick retries the snapshot.
        api.logger.warn('Could not persist break-reminder counters; will retry.', error)
      }
    })().finally(() => { writing = null })
    return writing
  }

  api.onEvent('llmhub:request-complete', ({ completion, context }) => {
    if (closed || completion.responseSource?.pluginId === 'break-reminder' || !context.apiKeyRecord) return
    const date = new Date(now())
    const configuration = settings(api)
    // Read the mark at event receipt, not when older queued work finishes.
    const marked = api.getRecordValues('apiKeys', context.apiKeyRecord.id)
      .then(values => values.counted === true, error => {
        api.logger.warn('Could not read break-reminder API-key mark; completion not counted.', error)
        return false
      })
    counting = counting.then(async () => {
      if (!await marked) return
      current(configuration, date)
      state.requests++
      state.tokens += nonnegative(completion.usage?.promptTokens) + nonnegative(completion.usage?.completionTokens)
      revision++
    })
  })

  api.registerHook({
    id: 'daily-limit',
    async onRequest(_request, context) {
      if (closed || !context.apiKeyRecord) return
      if ((await api.getRecordValues('apiKeys', context.apiKeyRecord.id)).counted !== true) return
      await counting
      const configuration = settings(api)
      const day = current(configuration)
      if (!(configuration.dailyTokens > 0 && state.tokens >= configuration.dailyTokens)
        && !(configuration.dailyRequests > 0 && state.requests >= configuration.dailyRequests)) return
      const messages = configuration.messages.length ? configuration.messages : DEFAULT_MESSAGES
      const replacements = { tokens: state.tokens.toLocaleString('en-US'), requests: String(state.requests), reset: day.reset }
      return { response: messages[Math.floor(Math.random() * messages.length)]
        .replace(/\{(tokens|requests|reset)\}/g, (_match, key) => replacements[key]) }
    }
  })

  api.registerMetric('today', async () => {
    await counting
    const configuration = settings(api)
    current(configuration)
    // A dashboard card has room for one short figure: how far along the nearest limit is.
    const shares = [[state.tokens, configuration.dailyTokens], [state.requests, configuration.dailyRequests]]
      .filter(([, limit]) => limit > 0).map(([used, limit]) => used / limit)
    return shares.length ? `${Math.floor(Math.max(...shares) * 100)}%` : 'No limit'
  })

  const timer = setInterval(() => { void flush() }, 1000)
  timer.unref?.()
  return async () => {
    closed = true
    clearInterval(timer)
    await counting
    current()
    await writing
    await flush()
  }
}

export default { setup }
