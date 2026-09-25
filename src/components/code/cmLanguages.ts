import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { php } from '@codemirror/lang-php'
import { vue } from '@codemirror/lang-vue'
import { yaml } from '@codemirror/lang-yaml'

// 没有独立语言包的语言走 legacy-modes（CodeMirror 5 的词法模式，用 StreamLanguage 复用）
import { c, csharp, kotlin, objectiveC, dart } from '@codemirror/legacy-modes/mode/clike'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { cmake } from '@codemirror/legacy-modes/mode/cmake'
import { vb } from '@codemirror/legacy-modes/mode/vb'

/** 按文件扩展名返回语法高亮的 CodeMirror 扩展；认不出来就返回 null（纯文本） */
export function getCmLanguage(fileName: string): Extension | null {
  const lower = fileName.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return StreamLanguage.define(dockerFile)
  if (lower === 'makefile' || lower === 'cmakelists.txt') return StreamLanguage.define(cmake)
  if (lower === 'nginx.conf') return StreamLanguage.define(nginx)

  const ext = lower.includes('.') ? lower.split('.').pop() || '' : ''
  switch (ext) {
    // 有原生语言包的
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: ext === 'tsx' })
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'vue':
      return vue()
    case 'py':
      return python()
    case 'rs':
      return rust()
    case 'go':
      return go()
    case 'java':
      return java()
    case 'c':
    case 'h':
      return StreamLanguage.define(c)
    case 'cpp':
    case 'hpp':
    case 'cc':
    case 'cxx':
      return cpp()
    case 'cs':
      return StreamLanguage.define(csharp)
    case 'kt':
    case 'kts':
      return StreamLanguage.define(kotlin)
    case 'm':
    case 'mm':
      return StreamLanguage.define(objectiveC)
    case 'dart':
      return StreamLanguage.define(dart)
    case 'php':
      return php()
    case 'rb':
      return StreamLanguage.define(ruby)
    case 'pl':
      return StreamLanguage.define(perl)
    case 'lua':
      return StreamLanguage.define(lua)
    case 'swift':
      return StreamLanguage.define(swift)
    case 'sql':
      return sql()
    case 'html':
    case 'htm':
      return html()
    case 'xml':
    case 'svg':
      return xml()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'json':
      return json()
    case 'yaml':
    case 'yml':
      return yaml()
    case 'toml':
      return StreamLanguage.define(toml)
    case 'ini':
    case 'conf':
    case 'env':
    case 'properties':
      return StreamLanguage.define(properties)
    case 'md':
    case 'markdown':
    case 'mdx':
      return markdown()
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
      return StreamLanguage.define(shell)
    case 'ps1':
    case 'psm1':
      return StreamLanguage.define(powerShell)
    case 'vb':
    case 'vbs':
      return StreamLanguage.define(vb)
    default:
      return null
  }
}
