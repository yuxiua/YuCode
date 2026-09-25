/**
 * 写代码扩展
 * PI Agent Extension - Code Writer
 * 
 * 支持：代码生成、重构、调试、测试、文档
 */

export interface CodeWriterOptions {
  language: string
  task: 'generate' | 'refactor' | 'debug' | 'test' | 'document'
  context?: string
  constraints?: string[]
  targetPath?: string
}

export interface CodeFile {
  path: string
  content: string
  language: string
}

export interface CodeTask {
  id: string
  description: string
  files: CodeFile[]
  commands?: string[]
  testCommands?: string[]
}

// Language-specific system prompts
const LANGUAGE_PROMPTS: Record<string, string> = {
  typescript: 'TypeScript, 严格模式, 使用现代语法(ES2022+)',
  javascript: 'JavaScript, ES2022+, 使用 const/let 代替 var',
  python: 'Python 3.11+, 遵循 PEP 8, 使用 type hints',
  rust: 'Rust, 零拷贝优先, 遵循 clippy 最佳实践',
  go: 'Go 1.21+, 标准库优先, 遵循 gofmt',
  java: 'Java 17+, 使用 record/sealed class 等现代特性',
  'c++': 'C++20, 现代 C++ 特性优先',
}

const TASK_PROMPTS: Record<string, string> = {
  generate: '根据需求生成完整可运行的代码，包含必要的错误处理和注释',
  refactor: '重构代码以提高可读性和性能，保持功能不变，说明重构原因',
  debug: '分析代码中的 bug，定位问题根因，提供修复方案',
  test: '为给定代码编写全面的单元测试，覆盖边界情况和异常场景',
  document: '为代码添加清晰的文档注释，包括函数说明、参数描述和使用示例',
}

export function getCodeWriterSystemPrompt(options: CodeWriterOptions): string {
  const lang = LANGUAGE_PROMPTS[options.language] || options.language
  const task = TASK_PROMPTS[options.task] || TASK_PROMPTS.generate

  return `你是一位资深 ${options.language} 工程师。

语言规范：${lang}
任务：${task}

${options.constraints?.length ? `约束：\n${options.constraints.map((c) => `- ${c}`).join('\n')}` : ''}

原则：
1. 代码简洁高效，避免过度工程化
2. 遵循该语言的最佳实践
3. 变量命名有意义
4. 适当的错误处理
5. 关键逻辑添加注释`
}

// Parse a code response into file operations
export function parseCodeResponse(response: string): CodeFile[] {
  const files: CodeFile[] = []
  const blockRegex = /```(\w+)?\n([\s\S]*?)```/g
  let match

  while ((match = blockRegex.exec(response)) !== null) {
    const language = match[1] || 'text'
    const content = match[2].trim()
    files.push({
      path: '',
      content,
      language,
    })
  }
  return files
}
