/**
 * 文件扩展名 → 语言标识。
 * 从 CodeViewer 抽出来，让 store / 工具函数也能用而不必反向依赖组件。
 */

const extLanguageMap: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  sql: 'sql',
  html: 'markup',
  htm: 'markup',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  dockerfile: 'docker',
  xml: 'markup',
  svg: 'markup',
  graphql: 'graphql',
  gql: 'graphql',
}

export function getLanguageFromExt(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const base = fileName.toLowerCase()
  if (base === 'dockerfile') return 'docker'
  return extLanguageMap[ext] || 'text'
}
