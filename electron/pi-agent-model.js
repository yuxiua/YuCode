/**
 * 应用里的模型配置 → pi 能认的 provider 条目。
 *
 * pi 只认它自己的 ~/.pi/agent/models.json；界面上的模型页是用户填配置的地方，
 * pi 是执行方，两份配置得打通：这里把应用当前的模型合并写进 pi 的配置
 * （provider 名加前缀，其它条目原样保留），再用 --model <provider>/<id> 指过去。
 *
 * 没给 baseUrl 就返回失败 —— 那是 pi 自己配置里的模型，不该由我们去改写它。
 *
 * 为什么这里要「清洗」整份文件：
 *   pi 读 models.json 时用 TypeBox 校验**整份文档**，provider 里的 baseUrl / apiKey
 *   都要求 minLength:1。只要有一条 provider 写了空串（历史版本写进去的、用户手改的），
 *   整份文件校验就不通过，pi 会把**所有** provider 一起丢掉，然后在启动时报
 *   `Model "yucode-xxx/yyy" not found` 直接退出 —— 现象看是「模型没登记」，
 *   实际是「一条脏数据把所有登记都带走了」。所以每次写盘前把空字符串字段清掉，
 *   写完之后再回读确认自己的 provider 真的在里面，失败就把原因交回调用方。
 */

const fs = require('fs')
const path = require('path')

const { MODELS_PATH, SETTINGS_PATH, runPi } = require('./pi')

const PROVIDER_PREFIX = 'yucode-'

/**
 * 用户没填 apiKey 时的占位值。
 * 本地端点（127.0.0.1/vLLM/LM Studio…）不填 key 很常见，但空串会让整份文件校验失败。
 * 占位值只在「有没有配 key」这一步被用到，请求时当普通 key 发出去，本地服务会忽略。
 */
const PLACEHOLDER_API_KEY = 'yucode-no-key'

/** 校验要求非空字符串的 provider 级字段 */
const PROVIDER_STRING_FIELDS = ['name', 'baseUrl', 'api', 'apiKey']
/** 校验要求非空字符串的 model 级字段 */
const MODEL_STRING_FIELDS = ['id', 'name', 'api', 'baseUrl']

function firstString(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return ''
}

function slug(text) {
  const out = String(text || 'custom')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return out || 'custom'
}

/**
 * 修掉一条 provider 里会让整份文件校验不过的字段。
 * apiKey 缺失/为空 → 补占位值（本地模型没 key 是常态）；
 * 其余要求非空的字段为空 → 直接删掉这个键（可选字段，删了不影响语义）。
 * @returns {boolean} 是否有改动
 */
function sanitizeProvider(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  let changed = false

  for (const field of PROVIDER_STRING_FIELDS) {
    if (!(field in entry)) continue
    const value = entry[field]
    if (typeof value === 'string' && value.trim()) continue
    if (field === 'apiKey') entry[field] = PLACEHOLDER_API_KEY
    else delete entry[field]
    changed = true
  }

  if (!Array.isArray(entry.models)) return changed
  const kept = []
  for (const model of entry.models) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) { changed = true; continue }
    for (const field of MODEL_STRING_FIELDS) {
      if (!(field in model)) continue
      const value = model[field]
      if (typeof value === 'string' && value.trim()) continue
      delete model[field]
      changed = true
    }
    // id 是必填的，删完还是空的这条模型就没法用了，整条丢掉
    if (typeof model.id !== 'string' || !model.id.trim()) { changed = true; continue }
    kept.push(model)
  }
  if (kept.length !== entry.models.length) entry.models = kept
  return changed
}

function readModelsDoc() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* 文件不存在或不是合法 JSON 时，从空文档重建 */ }
  return {}
}

/**
 * 原子写：先写临时文件再改名，避免 pi 正好在这时读到一个写了一半的文件。
 * 改名在同一分区内是原子的，Windows 上 rename 覆盖已存在文件会失败，所以先删旧的。
 */
function writeFileAtomic(file, content) {
  const tmp = `${file}.yucode-tmp`
  fs.writeFileSync(tmp, content, 'utf-8')
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.rmSync(file, { force: true })
    fs.renameSync(tmp, file)
  }
}

/**
 * 把界面选的模型写进 pi 的 provider 清单。
 * @returns {{ok: true, provider: string, modelId: string} | {ok: false, error: string}}
 */
function registerModel(config) {
  const modelId = firstString(config?.model)
  const baseUrl = firstString(config?.baseUrl)
  if (!modelId) return { ok: false, error: '模型名称为空' }
  if (!baseUrl) return { ok: false, error: 'Base URL 为空（不填就无法把模型登记给 Pi）' }

  const provider = PROVIDER_PREFIX + slug(config.provider)
  const doc = readModelsDoc()
  const providers = { ...(doc.providers || {}) }

  providers[provider] = {
    api: config.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    baseUrl,
    apiKey: firstString(config.apiKey) || PLACEHOLDER_API_KEY,
    models: [{
      id: modelId,
      name: firstString(config.displayName, modelId),
      contextWindow: Number(config.contextWindow) || 128000,
      maxTokens: Number(config.maxOutputTokens) || 8192,
    }],
  }

  // 顺手把文件里其它 provider 上的脏字段也修掉：留着它们会连累我们刚写进去的这条
  let repaired = 0
  for (const key of Object.keys(providers)) {
    if (!providers[key] || typeof providers[key] !== 'object' || Array.isArray(providers[key])) {
      delete providers[key]
      repaired += 1
      continue
    }
    if (sanitizeProvider(providers[key])) repaired += 1
  }
  if (repaired) console.warn(`[pi-agent] models.json 里有 ${repaired} 个 provider 字段不合法，已就地修正`)

  try {
    fs.mkdirSync(path.dirname(MODELS_PATH), { recursive: true })
    writeFileAtomic(MODELS_PATH, `${JSON.stringify({ ...doc, providers }, null, 2)}\n`)
  } catch (e) {
    console.error('[pi-agent] 写 models.json 失败:', e.message)
    return { ok: false, error: `写 ${MODELS_PATH} 失败：${e.message}` }
  }

  // 回读确认：磁盘上的内容才是 pi 会读到的内容，写成功不等于写对了
  const written = readModelsDoc()
  const entry = written.providers?.[provider]
  const listed = Array.isArray(entry?.models) && entry.models.some((m) => m.id === modelId)
  if (!listed) {
    console.error(`[pi-agent] models.json 回读校验失败：${provider}/${modelId} 不在文件里`)
    return { ok: false, error: `${provider}/${modelId} 写入后校验失败（models.json 未生效）` }
  }

  setPiDefault(provider, modelId)
  return { ok: true, provider, modelId }
}

/**
 * 顺手把 pi 的默认模型也指向它。否则一旦 --model 没能生效（例如会话是别处起的），
 * pi 会退回 settings.json 里那个可能早就失效的 defaultModel，用的就不是界面选的模型了。
 * 写入失败不影响本次 --model，所以只记日志。
 */
function setPiDefault(provider, modelId) {
  let settings = null
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed
  } catch { /* 读不到就不动它，别把用户配置写坏 */ }
  if (!settings) return
  if (settings.defaultProvider === provider && settings.defaultModel === modelId) return
  try {
    writeFileAtomic(SETTINGS_PATH, `${JSON.stringify({
      ...settings, defaultProvider: provider, defaultModel: modelId,
    }, null, 2)}\n`)
  } catch (e) {
    console.error('[pi-agent] 写 settings.json 默认模型失败:', e.message)
  }
}

/** 直连端点发一次最小请求：验证地址通不通、模型名认不认，这两项才是真正决定能不能聊的 */
async function pingEndpoint({ baseUrl, apiKey, model, timeoutMs = 20000 }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey || PLACEHOLDER_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 300)}` }
    }
    const data = await res.json().catch(() => null)
    if (!data) return { ok: false, error: '响应不是合法 JSON（地址可能指向了非模型服务）' }
    return { ok: true, model: data.model || model }
  } catch (e) {
    const reason = e.name === 'AbortError' ? `${timeoutMs / 1000}s 内没有响应` : e.message
    return { ok: false, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

/** 在 pi 眼里这个模型存不存在。pi 用的是模糊搜索，命中行里要能同时看到 provider 和模型名 */
async function verifyPiKnows(provider, modelId) {
  const res = await runPi(['--list-models', `${provider}/${modelId}`], { env: { PI_OFFLINE: '1' }, timeout: 60000 })
  if (!res.ok) return { ok: false, error: res.error || res.stderr || 'pi --list-models 执行失败' }

  const stdout = String(res.stdout || '')
  const stderr = String(res.stderr || '')
  // pi 读 models.json 失败时只在 stderr 里给一行 warning，然后照样列出别的模型。
  // 这行是「配置写进去了 pi 却不认」的直接证据，比下面的 not found 有用得多。
  if (/errors loading models\.json/i.test(stderr)) {
    return { ok: false, error: `pi 加载 models.json 报错：${stderr.trim().slice(0, 500)}` }
  }
  if (!stdout.includes(provider) || !stdout.includes(modelId)) {
    return { ok: false, error: `pi 的模型清单里没有 ${provider}/${modelId}`, listed: stdout.trim().slice(0, 500) }
  }
  return { ok: true }
}

/**
 * 设置页「测试」按钮的后端。
 * 三步依次是「写进 pi」「端点能聊」「pi 认得」，任何一步失败都直接说出来，
 * 因为这三步正好对应「配好了却报 Model not found / 连不上」的所有原因。
 * @returns {{ok: boolean, steps: {name: string, ok: boolean, detail: string}[]}}
 */
async function testModel(config) {
  const steps = []
  const registered = registerModel(config)
  steps.push({
    name: '登记到 Pi',
    ok: registered.ok,
    detail: registered.ok
      ? `已写入 ${MODELS_PATH}（${registered.provider}/${registered.modelId}）`
      : registered.error,
  })

  const model = firstString(config?.model)
  const baseUrl = firstString(config?.baseUrl)
  if (baseUrl) {
    const ping = await pingEndpoint({ baseUrl, apiKey: config?.apiKey, model })
    steps.push({
      name: '端点连通',
      ok: ping.ok,
      detail: ping.ok ? `POST ${baseUrl.replace(/\/+$/, '')}/chat/completions 正常` : ping.error,
    })
  } else {
    steps.push({ name: '端点连通', ok: false, detail: 'Base URL 为空' })
  }

  if (registered.ok) {
    const knows = await verifyPiKnows(registered.provider, registered.modelId)
    steps.push({
      name: 'Pi 可识别',
      ok: knows.ok,
      detail: knows.ok ? `pi --list-models 能找到 ${registered.provider}/${registered.modelId}` : knows.error,
    })
  } else {
    steps.push({ name: 'Pi 可识别', ok: false, detail: '上一步没写进 Pi，跳过' })
  }

  return { ok: steps.every((s) => s.ok), steps }
}

module.exports = { registerModel, testModel, PROVIDER_PREFIX }
