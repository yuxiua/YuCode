/**
 * 随应用分发的自定义 pi 扩展的安装。
 *
 * pi 内核缺一些能力（后台进程、项目规则写入），我们用扩展补上 —— 扩展源码随应用
 * 分发（repo 根的 pi-extensions/），启动时复制到 pi 会自动发现的全局扩展目录
 * ~/.pi/agent/extensions/ 下，pi 起会话时就会加载它：不需要联网、不用装包、
 * 也不用改 pi 的 settings。
 *
 * 本模块只管「照单装好」：清单在 EXTENSIONS，每个扩展的用途写在它自己的源码里
 * （pi-extensions/*.ts 的头部注释）。
 *
 * 只在内容对不上时才重写（没变就一个字节都不写），既避免每次启动都往用户目录里搬一遍，
 * 也能在文件被删掉/写到一半时自愈。
 */

const fs = require('fs')
const path = require('path')

const { PI_AGENT_DIR } = require('./extensions')

// 开发态是 <repo>/pi-extensions/<name>，打包后在 app.asar 里仍是同一层相对路径
const SOURCE_DIR = path.join(__dirname, '..', 'pi-extensions')
const TARGET_DIR = path.join(PI_AGENT_DIR, 'extensions')

/** 随应用分发、每次启动都要保证装好的扩展 */
const EXTENSIONS = ['yu-code-background-jobs.ts', 'yu-code-rules.ts']

function read(file) {
  try { return fs.readFileSync(file, 'utf-8') } catch { return null }
}

/**
 * 装一个扩展。任何一步失败都不抛：扩展缺失只影响那一个能力，不该挡住应用启动。
 * @returns {{ name: string, installed: boolean, reason?: string }}
 */
function install(name) {
  const source = read(path.join(SOURCE_DIR, name))
  if (source === null) {
    console.warn(`[custom-ext] 读不到扩展源码（${name}），跳过安装`)
    return { name, installed: false, reason: 'no-source' }
  }

  const target = path.join(TARGET_DIR, name)
  // 按内容比对，不用时间戳：内容一致就什么都不做，
  // 文件被删掉或被改坏（写到一半、用户手改）时下次启动能自动修复。
  if (read(target) === source) return { name, installed: false, reason: 'up-to-date' }

  try {
    fs.mkdirSync(TARGET_DIR, { recursive: true })
    fs.writeFileSync(target, source, 'utf-8')
    console.log(`[custom-ext] 已安装扩展到 ${target}`)
    return { name, installed: true }
  } catch (e) {
    console.error(`[custom-ext] 安装扩展 ${name} 失败:`, e.message)
    return { name, installed: false, reason: e.message }
  }
}

/** 启动时调用一次。返回每个扩展的结果，只用于日志 */
function ensure() {
  return EXTENSIONS.map(install)
}

module.exports = { ensure, EXTENSIONS, TARGET_DIR }
