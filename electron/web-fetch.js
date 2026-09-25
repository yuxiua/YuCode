/**
 * 联网抓取辅助：把网页 HTML 变成能塞给模型的纯文本。
 * 从 agent.js 拆出来，避免主循环文件继续膨胀。
 */

const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function decodeEntities(s) {
  const named = {
    nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', middot: '·', hellip: '…',
    mdash: '—', ndash: '–', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”',
    lt: '<', gt: '>', quot: '"', apos: "'",
  }
  return String(s)
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m)
    .replace(/&amp;/g, '&')
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function httpGet(url, timeout = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': WEB_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { WEB_UA, decodeEntities, stripTags, htmlToText, httpGet }
