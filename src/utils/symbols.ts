/**
 * 轻量符号定位：在**单个文件内**找出某个名字的定义位置。
 *
 * 这是 ctrl+左键跳转的「快路径」——不启动任何语言服务，纯正则扫一遍当前文件，
 * 命中了就地跳转；没命中才去走主进程的项目级扫描（见 electron/symbol-search.js）。
 * 两边认得是同一批定义写法，改规则时请一起改。
 */

export interface SymbolLocation {
  /** 1 起的行号 */
  line: number
  /** 0 起的列号 */
  column: number
}

/** 给定名字，返回该名字的「定义行」匹配规则（按可信度从高到低） */
export function definitionPatterns(name: string): RegExp[] {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    // JS/TS
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?type\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?enum\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${esc}\\b`),
    // Python
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${esc}\\b`),
    // Go
    new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${esc}\\b`),
    new RegExp(`^\\s*type\\s+${esc}\\b`),
    // Rust
    new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:pub\\s+)?(?:struct|enum|trait|union)\\s+${esc}\\b`),
    // Ruby / PHP
    new RegExp(`^\\s*module\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:(?:public|private|protected|static)\\s+)*function\\s+${esc}\\b`),
    // C / C++ / Java / C# / Kotlin / Swift：类型在前、名字在后的函数或变量定义
    new RegExp(`^\\s*(?:(?:public|private|protected|static|final|internal|open|override)\\s+)*[\\w<>\\[\\]?,\\.:\\s]*\\b${esc}\\s*[(<]`),
    // 兜底：赋值 / 字段 / 配置项写法
    new RegExp(`^\\s*(?:export\\s+)?\\$?${esc}\\s*[:=]`),
  ]
}

/**
 * 在 source 里找 name 的定义。
 * @param fromLine 从这个 1 起的行号之后开始找（用于「已经跳过一次就找下一个定义」）
 */
export function findDefinitionInText(
  source: string,
  name: string,
  fromLine = 1,
): SymbolLocation | null {
  if (!name) return null
  const lines = source.split('\n')
  for (const re of definitionPatterns(name)) {
    for (let i = fromLine - 1; i < lines.length; i++) {
      const m = re.exec(lines[i])
      if (!m) continue
      const col = lines[i].indexOf(name, m.index)
      return { line: i + 1, column: col >= 0 ? col : m.index }
    }
  }
  return null
}

/** 取出 pos 处所在的标识符；不在标识符上返回 null */
export function wordAtOffset(text: string, pos: number): string | null {
  if (pos < 0 || pos > text.length) return null
  const re = /[A-Za-z_$][\w$]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length
    // 光标落在标识符内部或紧贴右边界也算命中
    if (pos >= m.index && pos <= end) return m[0]
    if (m.index > pos) break
  }
  return null
}
