import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const load = () => import('../index.mjs')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** A stand-in for the injected API that records what a plugin registers. */
function host(config = {}, records = {}) {
  const state = { hooks: [], events: new Map(), routes: new Map(), metrics: new Map(), storage: new Map(), warnings: [], configListeners: [] }
  const api = {
    config,
    registerHook: hook => state.hooks.push(hook),
    onEvent: (name, listener) => state.events.set(name, listener),
    registerRoute: (method, path, handler) => state.routes.set(`${method} ${path}`, handler),
    registerMetric: (key, getter) => state.metrics.set(key, getter),
    onConfigChange: listener => state.configListeners.push(listener),
    getRecordValues: async (location, id) => records[`${location}:${id}`] || {},
    storage: {
      getItem: async key => structuredClone(state.storage.get(key) ?? null),
      setItem: async (key, value) => { state.storage.set(key, structuredClone(value)) },
      removeItem: async key => { state.storage.delete(key) }
    },
    logger: { info() {}, warn: (...values) => state.warnings.push(values.join(' ')), error() {} }
  }
  return { api, state }
}
/** Exercise the public plugin API with a local clock and mutable record settings. */
async function breakReminderHost(t, configuration = {}, options = {}) {
  const { setup, default: plugin } = await load()
  assert.equal(plugin.setup, setup)
  const records = { 'apiKeys:tracked': { counted: true }, 'apiKeys:ignored': { counted: false } }
  const instance = host({ dailyTokens: 0, dailyRequests: 0, resetHour: 4, messages: 'Take a break.', ...configuration }, records)
  let date = new Date(2030, 0, 2, 12)
  if (options.daily) instance.state.storage.set('daily', structuredClone(options.daily))
  const cleanup = await setup(instance.api, () => new Date(date))
  let stopped = false
  async function stop() {
    if (stopped) return
    stopped = true
    await cleanup()
  }
  t.after(stop)
  const context = id => ({ apiKeyRecord: { id, name: 'not-the-record-id', hash: 'not-the-record-id' } })
  return {
    ...instance, records, stop,
    setTime(value) { date = value },
    async configure(values) {
      Object.assign(instance.api.config, values)
      for (const listener of instance.state.configListeners) await listener(instance.api.config)
    },
    emit(overrides = {}, id = 'tracked') {
      return instance.state.events.get('llmhub:request-complete')({
        completion: { model: 'openai/gpt', usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 4 }, ...overrides },
        context: context(id)
      })
    },
    request(id = 'tracked') {
      return instance.state.hooks.find(hook => hook.onRequest).onRequest({ model: 'openai/gpt', messages: [] }, context(id))
    },
    metric() { return instance.state.metrics.get('today')() }
  }
}

function assertReminder(result, message = 'Take a break.') {
  assert.ok(result && Object.hasOwn(result, 'response'), 'quota exhaustion returns a plugin response, not an error or request rewrite')
  assert.equal(result.response, message)
}

test('break-reminder checks API key record IDs and marking/unmarking takes effect immediately', async t => {
  const instance = await breakReminderHost(t, { dailyRequests: 1 })
  const lookup = t.mock.method(instance.api, 'getRecordValues', instance.api.getRecordValues)
  await instance.emit({}, 'ignored')
  await instance.emit({}, 'missing')
  assert.equal(await instance.request(), undefined)
  await instance.emit()
  assertReminder(await instance.request())
  assert.equal(await instance.request('ignored'), undefined)
  assert.equal(await instance.request('missing'), undefined)
  instance.records['apiKeys:tracked'].counted = false
  assert.equal(await instance.request(), undefined, 'unmarking bypasses an already exhausted budget')
  instance.records['apiKeys:ignored'].counted = true
  assertReminder(await instance.request('ignored'), 'Take a break.')
  assert.ok(lookup.mock.calls.length > 0)
  assert.ok(lookup.mock.calls.every(call => call.arguments[0] === 'apiKeys' && ['tracked', 'ignored', 'missing'].includes(call.arguments[1])))
})

test('break-reminder counts input plus output tokens without double-counting cached input', async t => {
  const instance = await breakReminderHost(t, { dailyTokens: 20 })
  await instance.emit({ usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 8 } })
  assert.equal(await instance.request(), undefined, '15 total tokens: cached input is already included in promptTokens')
  await instance.emit({ usage: { promptTokens: 2, completionTokens: 2, cachedTokens: 2 } })
  assert.equal(await instance.request(), undefined, '19 total tokens remain below 20')
  await instance.emit({ usage: { promptTokens: 0, completionTokens: 1, cachedTokens: 0 } })
  assertReminder(await instance.request())
})

test('break-reminder counts failed and other-plugin requests but excludes its own responses', async t => {
  const instance = await breakReminderHost(t, { dailyRequests: 2, dailyTokens: 100 })
  await instance.emit({ responseSource: { pluginId: 'break-reminder', hookId: 'break-reminder:any-hook' }, usage: { promptTokens: 1000 } })
  assert.equal(await instance.request(), undefined)
  await instance.emit({ error: new Error('upstream failed'), usage: undefined })
  assert.equal(await instance.request(), undefined)
  await instance.emit({ responseSource: { pluginId: 'other-plugin', hookId: 'other-plugin:reply' }, usage: undefined })
  assertReminder(await instance.request())
})

test('break-reminder token and request limits work independently, together, and when disabled', async t => {
  for (const configuration of [
    { dailyTokens: 10, dailyRequests: 0 },
    { dailyTokens: 0, dailyRequests: 1 },
    { dailyTokens: 10, dailyRequests: 100 },
    { dailyTokens: 1000, dailyRequests: 1 },
    { dailyTokens: 10, dailyRequests: 1 }
  ]) {
    await t.test(JSON.stringify(configuration), async child => {
      const instance = await breakReminderHost(child, configuration)
      assert.equal(await instance.request(), undefined)
      await instance.emit()
      assertReminder(await instance.request())
    })
  }
  const disabled = await breakReminderHost(t)
  for (let index = 0; index < 5; index++) await disabled.emit()
  assert.equal(await disabled.request(), undefined)
  assert.equal(typeof await disabled.metric(), 'string')
})

test('break-reminder completion observes asynchronously fetched current marks', async t => {
  const instance = await breakReminderHost(t, { dailyRequests: 1 })
  let resolveRecord
  t.mock.method(instance.api, 'getRecordValues', () => new Promise(resolve => { resolveRecord = resolve }))
  const completing = instance.emit()
  assert.equal(typeof resolveRecord, 'function')
  resolveRecord({ counted: false })
  await completing
  const request = instance.request()
  resolveRecord({ counted: true })
  assert.equal(await request, undefined, 'an uncounted completion cannot exhaust the budget')
})

test('break-reminder hot settings updates retain usage and affect the next request', async t => {
  const instance = await breakReminderHost(t, { dailyRequests: 2 })
  await instance.emit()
  assert.equal(await instance.request(), undefined)
  await instance.configure({ dailyRequests: 1, messages: 'Updated reminder' })
  assertReminder(await instance.request(), 'Updated reminder')
  await instance.configure({ dailyRequests: 3 })
  assert.equal(await instance.request(), undefined)
  await instance.configure({ dailyRequests: 0, dailyTokens: 10 })
  assertReminder(await instance.request(), 'Updated reminder')
})

test('break-reminder resets at the local reset hour, not at midnight, and cleanup survives restart', async t => {
  const first = await breakReminderHost(t, { dailyRequests: 1 })
  first.setTime(new Date(2030, 0, 2, 23, 59))
  await first.emit()
  first.setTime(new Date(2030, 0, 3, 0, 0))
  assertReminder(await first.request())
  first.setTime(new Date(2030, 0, 3, 3, 59, 59))
  assertReminder(await first.request())
  await first.stop()
  assert.ok(first.state.storage.has('daily'), 'cleanup flushes the daily state')
  const second = await breakReminderHost(t, { dailyRequests: 1 }, { daily: first.state.storage.get('daily') })
  second.setTime(new Date(2030, 0, 3, 3, 59, 59))
  assertReminder(await second.request())
  second.setTime(new Date(2030, 0, 3, 4, 0))
  assert.equal(await second.request(), undefined)
  await second.emit()
  assertReminder(await second.request())
  second.setTime(new Date(2030, 0, 6, 4, 0))
  assert.equal(await second.request(), undefined, 'multiple idle days still reset the budget')
})

test('break-reminder batches disk writes and an outstanding write does not block requests or counting', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const instance = await breakReminderHost(t, { dailyRequests: 100 })
  let releaseWrite
  const writes = t.mock.method(instance.api.storage, 'setItem', () => new Promise(resolve => { releaseWrite = resolve }))
  for (let index = 0; index < 20; index++) await instance.emit()
  assert.equal(writes.mock.callCount(), 0, 'completions do not perform a disk write each')
  t.mock.timers.tick(999)
  await Promise.resolve()
  assert.equal(writes.mock.callCount(), 0)
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.equal(writes.mock.callCount(), 1, 'one second flush batches the burst')
  assert.equal(writes.mock.calls[0].arguments[0], 'daily')
  try {
    await Promise.race([
      (async () => {
        await instance.emit()
        assert.equal(await instance.request(), undefined, 'request does not await blocked persistence')
      })(),
      new Promise((resolve, reject) => setImmediate(() => reject(new Error('counting or request waited for disk persistence'))))
    ])
  } finally {
    releaseWrite()
    writes.mock.restore()
  }
  await instance.stop()
  const restarted = await breakReminderHost(t, { dailyRequests: 21 }, { daily: instance.state.storage.get('daily') })
  assertReminder(await restarted.request(), 'Take a break.')
})

const defaultBreakMessages = [
  '今天已经写了 {requests} 轮、{tokens} 个 token 了。合上电脑吧,代码明天还在。',
  '到点了。站起来走走,喝口水,{reset} 之后再来。',
  '你今天的额度用完了。不是模型累了,是你该休息了。',
  '今天就到这儿。去睡觉,bug 在梦里不会变多。',
  '已达到今天的上限({tokens} token)。{reset} 重置,在那之前请离开键盘。'
].join('\n')

test('break-reminder renders every custom placeholder and selects from multiline messages', async t => {
  const messages = 'tokens={tokens}; requests={requests}; reset={reset}; again={tokens}/{requests}/{reset}\nSecond: {tokens}, {requests}, {reset}'
  const instance = await breakReminderHost(t, { dailyRequests: 2, resetHour: 4, messages })
  await instance.emit({ usage: { promptTokens: 1000, completionTokens: 234, cachedTokens: 500 } })
  await instance.emit({ usage: { promptTokens: 0, completionTokens: 0 } })
  t.mock.method(Math, 'random', () => 0)
  assertReminder(await instance.request(), 'tokens=1,234; requests=2; reset=04:00; again=1,234/2/04:00')
  t.mock.method(Math, 'random', () => 0.999)
  assertReminder(await instance.request(), 'Second: 1,234, 2, 04:00')
  await instance.configure({ resetHour: 9 })
  assertReminder(await instance.request(), 'Second: 1,234, 2, 09:00')
})

test('break-reminder exposes exact multiline defaults and uses them for an empty message pool', async t => {
  const fields = new Map(manifest.llmhub.configSchema.map(field => [field.key, field]))
  assert.equal(fields.get('dailyTokens').default, 0)
  assert.equal(fields.get('dailyRequests').default, 0)
  assert.equal(fields.get('resetHour').default, 4)
  const defaults = fields.get('messages').default
  assert.equal(defaults, defaultBreakMessages)
  const renderedDefaults = [
    '今天已经写了 1 轮、15 个 token 了。合上电脑吧,代码明天还在。',
    '到点了。站起来走走,喝口水,04:00 之后再来。',
    '你今天的额度用完了。不是模型累了,是你该休息了。',
    '今天就到这儿。去睡觉,bug 在梦里不会变多。',
    '已达到今天的上限(15 token)。04:00 重置,在那之前请离开键盘。'
  ]
  let selection = 0
  t.mock.method(Math, 'random', () => (selection + 0.5) / renderedDefaults.length)
  for (const messages of ['', '\n', ' \n\t\n ', undefined]) {
    const instance = await breakReminderHost(t, { dailyRequests: 1, messages })
    await instance.emit()
    for (selection = 0; selection < renderedDefaults.length; selection++) {
      assertReminder(await instance.request(), renderedDefaults[selection])
    }
  }
})

test('break-reminder today metric reports progress toward the nearest limit', async t => {
  const instance = await breakReminderHost(t, { dailyTokens: 123, dailyRequests: 47 })
  await instance.emit({ usage: { promptTokens: 19, completionTokens: 100, cachedTokens: 9 } })
  assert.equal(await instance.metric(), '96%')
  await instance.configure({ dailyTokens: 321, dailyRequests: 74 })
  assert.equal(await instance.metric(), '37%')
  await instance.configure({ dailyTokens: 0, dailyRequests: 2 })
  assert.equal(await instance.metric(), '50%')
  await instance.configure({ dailyTokens: 0, dailyRequests: 0 })
  assert.equal(await instance.metric(), 'No limit')
})

test('break-reminder reset-hour changes take effect without restarting the plugin', async t => {
  const instance = await breakReminderHost(t, { dailyRequests: 1 })
  instance.setTime(new Date(2030, 0, 2, 12))
  await instance.emit()
  instance.setTime(new Date(2030, 0, 3, 3))
  assertReminder(await instance.request())
  await instance.configure({ resetHour: 2 })
  assert.equal(await instance.request(), undefined)
  await instance.emit()
  assertReminder(await instance.request())
})

test('the package is one the LLMHub market can find and install', () => {
  assert.equal(manifest.name, 'llmhub-plugin-break-reminder')
  assert.ok(manifest.keywords.includes('llmhub-plugin'))
  assert.match(manifest.engines.llmhub, /^\^1\.\d+\.0$/)
  assert.ok(manifest.llmhub.name)
})
