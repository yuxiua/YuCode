/**
 * 精确编辑引擎：把「搜索 + 替换」做成一个可验证、可展示的操作。
 *
 * 解决原先 toolEditFile 的三个问题：
 *   1. String.replace 只替换第一处 —— 文件里有多处相同片段时会静默改错地方
 *   2. 匹配失败只回一句「未找到」，模型不知道自己哪里抄错了，没法自我纠正
 *   3. 改完不产出差异，界面无法展示这次到底改了什么
 *
 * 这里只有纯函数，不碰文件系统，方便单独验证。
 */

/** LCS 动态规划的最大格子数，超出就退化成「整段删 + 整段加」，避免巨型文件把内存打爆 */
const MAX_LCS_CELLS = 1000000
/** unified diff 每个 hunk 上下保留的上下文行数 */
const CONTEXT_LINES = 3

function detectLineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** 统一成 LF 做匹配，写回时再还原，避免 CRLF 文件永远匹配不上 */
function normalizeToLF(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function restoreLineEndings(text, eol) {
  return eol === '\n' ? text : text.replace(/\n/g, eol)
}

/** 宽松比较用的行归一化：去行尾空白 + 把智能引号/破折号/不换行空格换成 ASCII */
function normalizeLine(s) {
  return String(s)
    .replace(/[ \t]+$/, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00a0/g, ' ')
}

/** 出现次数。用 needle.length 步进，只看「互不重叠」的匹配，这也正是「是否唯一」的判据 */
function countOccurrences(content, needle) {
  if (!needle) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = content.indexOf(needle, from)
    if (at === -1) return count
    count++
    from = at + needle.length
  }
}

/**
 * 行对齐的宽松匹配。
 * 只在 needle 正好整行对齐时才会命中 —— 这样替换的边界就是行边界，
 * 字符偏移能算得准，不会像模糊替换那样把缩进吃掉或叠加。
 */
function findFuzzyWindow(content, needle) {
  const cLines = content.split('\n')
  const nLines = normalizeToLF(needle).split('\n')
  if (nLines.length === 0 || nLines.length > cLines.length) return null

  const cn = cLines.map(normalizeLine)
  const nn = nLines.map(normalizeLine)
  const hits = []
  for (let i = 0; i + nLines.length <= cLines.length; i++) {
    let ok = true
    for (let j = 0; j < nLines.length; j++) {
      if (cn[i + j] !== nn[j]) { ok = false; break }
    }
    if (!ok) continue
    hits.push(i)
    // 已经不止一处了，再找下去也没意义
    if (hits.length > 1) return { occurrences: hits.length }
  }
  if (hits.length !== 1) return null

  const startLine = hits[0]
  let start = 0
  for (let i = 0; i < startLine; i++) start += cLines[i].length + 1
  const matched = cLines.slice(startLine, startLine + nLines.length).join('\n')
  return { start, end: start + matched.length, startLine, occurrences: 1 }
}

/** 二元组 Dice 相似度，只用于「匹配失败时猜猜模型想改哪一行」 */
function similarity(a, b) {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const bigrams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const A = bigrams(a)
  const B = bigrams(b)
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size)
}

/**
 * 匹配失败时给出「最接近的位置」。
 * 模型抄错一两处空白时，这比一句「未找到」有用得多 —— 它能据此重试成功。
 */
function describeNearest(content, needle) {
  const firstLine = normalizeToLF(needle).split('\n')[0]
  const target = normalizeLine(firstLine).trim()
  if (!target) return '请先 read_file 确认这段内容的当前样子。'

  const lines = content.split('\n')
  let best = -1
  let bestScore = 0
  for (let i = 0; i < lines.length; i++) {
    const l = normalizeLine(lines[i]).trim()
    if (!l) continue
    const score = similarity(l, target)
    if (score > bestScore) { bestScore = score; best = i }
  }
  if (best < 0 || bestScore < 0.5) {
    return '文件内容可能已被改动，请重新 read_file 后再编辑。'
  }
  const from = Math.max(0, best - 2)
  const to = Math.min(lines.length - 1, best + 3)
  const snippet = lines.slice(from, to + 1).map((l, k) => `${from + k + 1}  ${l}`).join('\n')
  return `最接近的是第 ${best + 1} 行附近：\n${snippet}\n请用上面这段实际内容重试。`
}

/**
 * 应用一组编辑。
 * edits: [{ old_content, new_content }]，同一份原始内容里可以一次改多处。
 */
function applyEdits(rawContent, edits) {
  const eol = detectLineEnding(rawContent)
  const content = normalizeToLF(rawContent)

  const list = (Array.isArray(edits) ? edits : [])
    .map((e) => ({
      oldText: normalizeToLF(e?.old_content ?? ''),
      newText: normalizeToLF(e?.new_content ?? ''),
    }))
  if (list.length === 0) {
    return { ok: false, error: '没有提供任何编辑项（每项需要 old_content 和 new_content）' }
  }

  const resolved = []
  const problems = []

  list.forEach((item, i) => {
    const label = list.length > 1 ? `第 ${i + 1} 处编辑：` : ''
    if (!item.oldText) { problems.push(`${label}old_content 不能为空`); return }
    if (item.oldText === item.newText) { problems.push(`${label}新旧内容完全相同，不需要改`); return }

    const exact = countOccurrences(content, item.oldText)
    if (exact === 1) {
      const start = content.indexOf(item.oldText)
      resolved.push({ index: i, start, end: start + item.oldText.length, newText: item.newText, fuzzy: false })
      return
    }
    if (exact > 1) {
      problems.push(
        `${label}这段内容在文件里出现了 ${exact} 次，无法确定改哪一处。` +
        `请在 old_content 里多带上几行上下文（连同前后几行一起复制），让它可以唯一定位。`,
      )
      return
    }

    const fuzzy = findFuzzyWindow(content, item.oldText)
    if (!fuzzy) {
      problems.push(`${label}文件里找不到这段内容。${describeNearest(content, item.oldText)}`)
      return
    }
    if (fuzzy.occurrences > 1) {
      problems.push(`${label}宽松匹配到 ${fuzzy.occurrences} 处，仍然不唯一，请补充上下文。`)
      return
    }
    resolved.push({ index: i, start: fuzzy.start, end: fuzzy.end, newText: item.newText, fuzzy: true })
  })

  if (problems.length > 0) return { ok: false, error: problems.join('\n') }

  const sorted = [...resolved].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      return {
        ok: false,
        error: `第 ${sorted[i - 1].index + 1} 处与第 ${sorted[i].index + 1} 处编辑范围重叠，请合并成一处。`,
      }
    }
  }

  // 从后往前替换，前面的偏移才不会因为长度变化而失效
  let out = content
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i]
    out = out.slice(0, r.start) + r.newText + out.slice(r.end)
  }

  return {
    ok: true,
    content: restoreLineEndings(out, eol),
    applied: sorted.length,
    fuzzyCount: sorted.filter((r) => r.fuzzy).length,
  }
}

/** 按行做 LCS，产出 same / del / add 序列（首尾相同的部分先裁掉，能大幅缩小 DP 规模） */
function diffOps(a, b) {
  const n = a.length
  const m = b.length
  let start = 0
  while (start < n && start < m && a[start] === b[start]) start++
  let endA = n
  let endB = m
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }

  const ops = []
  for (let i = 0; i < start; i++) ops.push({ type: 'same', text: a[i] })

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length === 0) {
    for (const t of midB) ops.push({ type: 'add', text: t })
  } else if (midB.length === 0) {
    for (const t of midA) ops.push({ type: 'del', text: t })
  } else if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (const t of midA) ops.push({ type: 'del', text: t })
    for (const t of midB) ops.push({ type: 'add', text: t })
  } else {
    const p = midA.length
    const q = midB.length
    const W = q + 1
    const dp = new Int32Array((p + 1) * W)
    for (let i = p - 1; i >= 0; i--) {
      for (let j = q - 1; j >= 0; j--) {
        dp[i * W + j] = midA[i] === midB[j]
          ? dp[(i + 1) * W + j + 1] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < p && j < q) {
      if (midA[i] === midB[j]) { ops.push({ type: 'same', text: midA[i] }); i++; j++ }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { ops.push({ type: 'del', text: midA[i] }); i++ }
      else { ops.push({ type: 'add', text: midB[j] }); j++ }
    }
    while (i < p) ops.push({ type: 'del', text: midA[i++] })
    while (j < q) ops.push({ type: 'add', text: midB[j++] })
  }

  for (let i = endA; i < n; i++) ops.push({ type: 'same', text: a[i] })
  return ops
}

/** 生成标准 unified diff，带 @@ 行号定位，界面和模型都能直接读 */
function unifiedDiff(oldText, newText, fileName = 'file') {
  const a = normalizeToLF(oldText).split('\n')
  const b = normalizeToLF(newText).split('\n')
  const ops = diffOps(a, b)

  let oldNo = 1
  let newNo = 1
  const lines = ops.map((op) => {
    const rec = {
      type: op.type,
      text: op.text,
      oldNo: op.type === 'add' ? null : oldNo,
      newNo: op.type === 'del' ? null : newNo,
    }
    if (op.type !== 'add') oldNo++
    if (op.type !== 'del') newNo++
    return rec
  })

  const changedIdx = []
  lines.forEach((l, i) => { if (l.type !== 'same') changedIdx.push(i) })
  if (changedIdx.length === 0) return { patch: '', added: 0, removed: 0 }

  const ranges = []
  for (const idx of changedIdx) {
    const from = Math.max(0, idx - CONTEXT_LINES)
    const to = Math.min(lines.length - 1, idx + CONTEXT_LINES)
    const last = ranges[ranges.length - 1]
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to)
    else ranges.push({ from, to })
  }

  const out = []
  let added = 0
  let removed = 0
  for (const r of ranges) {
    const slice = lines.slice(r.from, r.to + 1)
    const firstOld = slice.find((l) => l.oldNo !== null)
    const firstNew = slice.find((l) => l.newNo !== null)
    const oldStart = firstOld ? firstOld.oldNo : 0
    const newStart = firstNew ? firstNew.newNo : 0
    const oldLen = slice.filter((l) => l.type !== 'add').length
    const newLen = slice.filter((l) => l.type !== 'del').length
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`)
    for (const l of slice) {
      if (l.type === 'same') out.push(` ${l.text}`)
      else if (l.type === 'del') { out.push(`-${l.text}`); removed++ }
      else { out.push(`+${l.text}`); added++ }
    }
  }

  return { patch: `${out.join('\n')}\n`, added, removed }
}

module.exports = {
  applyEdits,
  unifiedDiff,
  normalizeToLF,
  detectLineEnding,
}
