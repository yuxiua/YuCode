/**
 * 上下文压缩块（对应 Pi 生态的 billion-context / billion-context-pi 扩展）。
 *
 * 思路：上下文里最占地方的不是「结论」而是「过程」——一屏屏的工具输出、读完就扔的
 * 文件内容。自动压缩（context.js）只能在阈值处被动救火，且压完全是摘要、丢掉的细节
 * 再也找不回来。这里给模型两件主动的工具：
 *
 *   compress        把一段消息换成自己写的高保真摘要（保留块，可检索、可还原）
 *   search_context  在已压缩块里按关键词检索，不必解压
 *   decompress      取回某块的原文
 *
 * 块按代（level）分层：T1 是原始消息的摘要，把若干 T1 再压一次就得到 T2……会话再长，
 * 块的数量和体积都保持有界。存档落在 <工作目录>/.yucode/context-blocks.json，
 * 和上下文压缩是两条独立的线——就算上下文被砍，块本身不会丢。
 */

const fs = require('fs')
const path = require('path')
const { estimateText } = require('./context')

const DIR_NAME = '.yucode'
const FILE_NAME = 'context-blocks.json'
// 单块原文上限：超过就掐头去尾存档，避免存档自己长成第二个上下文
const MAX_ORIGINAL_CHARS = 100000
const MAX_BLOCKS = 80
// 检索时单条命中的上下文窗口
const SNIPPET_RADIUS = 120

function filePath(projectDir) {
  return path.join(projectDir, DIR_NAME, FILE_NAME)
}

function readArchive(projectDir) {
  try {
    const raw = fs.readFileSync(filePath(projectDir), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.blocks) ? parsed.blocks : []
  } catch {
    return []
  }
}

function writeArchive(projectDir, blocks) {
  const file = filePath(projectDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ blocks }, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

/** 超长原文掐头去尾，中间标记省略了多少 */
function clipOriginal(text) {
  if (text.length <= MAX_ORIGINAL_CHARS) return text
  const head = Math.floor(MAX_ORIGINAL_CHARS * 0.6)
  const tail = MAX_ORIGINAL_CHARS - head
  return `${text.slice(0, head)}\n\n……（存档时省略了 ${text.length - MAX_ORIGINAL_CHARS} 字）……\n\n${text.slice(-tail)}`
}

function nextId(blocks) {
  let max = 0
  for (const b of blocks) {
    const n = Number.parseInt(String(b.id).replace(/^b/, ''), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `b${max + 1}`
}

/**
 * 落一个新的压缩块。
 * @param items [{ ref, role, text }] 被压掉的消息（原文）
 * @param level 压缩层数，缺省由调用方按被压块推算
 */
function createBlock(projectDir, { title, summary, items, level = 1 }) {
  const list = readArchive(projectDir)
  const refs = items.map((i) => i.ref).filter(Boolean)
  const originals = items
    .map((i) => `[${i.ref}｜${i.role}] ${i.text}`)
    .join('\n\n')
  const block = {
    id: nextId(list),
    level: Math.max(1, Math.min(9, Number(level) || 1)),
    title: String(title || '').trim().slice(0, 120) || '（未命名压缩块）',
    summary: String(summary || '').trim(),
    refs,
    charsOriginal: originals.length,
    tokensOriginal: estimateText(originals),
    tokensSummary: estimateText(String(summary || '')),
    createdAt: new Date().toISOString(),
    original: clipOriginal(originals),
  }
  list.push(block)
  // 只保留最近的若干块：更老的块说明会话已经翻过很多页了，留最近的最有用
  const kept = list.slice(-MAX_BLOCKS)
  writeArchive(projectDir, kept)
  return block
}

/** 块元信息（不含原文），界面与状态展示用 */
function listBlocks(projectDir) {
  return readArchive(projectDir).map((b) => ({
    id: b.id,
    level: b.level,
    title: b.title,
    refs: b.refs || [],
    tokensOriginal: b.tokensOriginal || 0,
    tokensSummary: b.tokensSummary || 0,
    createdAt: b.createdAt,
  }))
}

function getBlock(projectDir, id) {
  return readArchive(projectDir).find((b) => b.id === String(id || '').trim()) || null
}

function stats(projectDir) {
  const blocks = readArchive(projectDir)
  const byLevel = {}
  let tokensOriginal = 0
  let tokensSummary = 0
  for (const b of blocks) {
    byLevel[b.level] = (byLevel[b.level] || 0) + 1
    tokensOriginal += b.tokensOriginal || 0
    tokensSummary += b.tokensSummary || 0
  }
  return { count: blocks.length, byLevel, tokensOriginal, tokensSummary }
}

/** 关键词检索：标题/摘要/原文都搜，命中多的排前面 */
function searchBlocks(projectDir, query, limit = 8) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return []
  const hits = []
  for (const b of readArchive(projectDir)) {
    const haystack = `${b.title}\n${b.summary}\n${b.original || ''}`
    const lower = haystack.toLowerCase()
    let index = lower.indexOf(needle)
    if (index < 0) continue
    let count = 0
    let cursor = index
    while (cursor >= 0 && count < 50) {
      count++
      cursor = lower.indexOf(needle, cursor + needle.length)
    }
    index = Math.max(0, index - SNIPPET_RADIUS)
    hits.push({
      id: b.id,
      level: b.level,
      title: b.title,
      summary: b.summary,
      hits: count,
      snippet: haystack.slice(index, index + SNIPPET_RADIUS * 2).replace(/\s+/g, ' ').trim(),
    })
  }
  return hits.sort((a, b) => b.hits - a.hits).slice(0, Math.max(1, Math.min(30, limit)))
}

module.exports = {
  DIR_NAME,
  MAX_ORIGINAL_CHARS,
  filePath,
  readArchive,
  createBlock,
  listBlocks,
  getBlock,
  stats,
  searchBlocks,
}
