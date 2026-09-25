// ─── 可在编辑器中打开的文件类型 ───────────────────────────────────────────────
//
// 用白名单而不是黑名单：二进制格式列不全（exe / dll / so / pdb / 各种归档…），
// 一旦漏掉就会把二进制当文本读进来——轻则一片乱码，重则把渲染进程撑爆卡死。
// 白名单的默认行为是「不认识就不打开」，更安全。

/** 可编辑的文本类扩展名（小写） */
const EDITABLE_EXTENSIONS = new Set([
  // 代码
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyi', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'sc', 'groovy',
  'c', 'h', 'cpp', 'cxx', 'cc', 'hpp', 'hxx', 'hh', 'cs', 'go', 'rs', 'swift',
  'vue', 'svelte', 'astro', 'dart', 'lua', 'pl', 'pm', 'r', 'jl', 'm', 'mm',
  'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'bat', 'cmd',
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl',
  // 数据 / 配置
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'properties', 'xml', 'csv', 'tsv', 'graphql', 'gql', 'proto', 'gradle',
  'env', 'lock', 'sum', 'mod', 'editorconfig',
  // 文档 / 文本
  'md', 'markdown', 'mdx', 'txt', 'text', 'log', 'rst', 'adoc', 'tex',
])

/** 单文件大小上限，与主进程 fs:read 的阈值保持一致 */
export const MAX_EDITABLE_FILE_SIZE = 5 * 1024 * 1024

/** 取扩展名（小写）。点开头的隐藏文件（.env / .gitignore）视为无扩展名。 */
function extOf(fileName: string): string {
  const lower = fileName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return ''
  return lower.slice(dot + 1)
}

/**
 * 这个文件能不能在编辑器里打开。
 * 没有扩展名的（Dockerfile、LICENSE、.env…）按文本处理，其余必须命中白名单。
 */
export function isOpenableInEditor(fileName: string): boolean {
  const ext = extOf(fileName)
  if (!ext) return true
  return EDITABLE_EXTENSIONS.has(ext)
}

/** 不能打开时给出原因（可直接展示给用户）；能打开则返回 null */
export function unopenableReason(fileName: string): string | null {
  const ext = extOf(fileName)
  if (!ext) return null
  if (EDITABLE_EXTENSIONS.has(ext)) return null
  return `.${ext} 不是可编辑的文本文件，Yu Code 默认不在编辑器中打开它（避免读入二进制内容导致卡死）。`
}
