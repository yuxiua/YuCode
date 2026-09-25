// 打包用的版本号处理。
//
// 版本号决定安装包的文件名和 Windows 卸载列表里显示的那个数字，所以每次打包都应该
// 往前走一格，否则覆盖安装上去看不出是新版本。这里只改 package.json 的 version，
// electron 与 electron-builder 都从那里读，不需要再同步别处。
//
// 用法（也可以由 scripts/build.js 把参数透传进来）：
//   不带参数    patch 自增    1.0.0 → 1.0.1
//   patch       同上
//   minor      次版本自增    1.0.0 → 1.1.0
//   major      主版本自增    1.0.0 → 2.0.0
//   1.2.3      直接指定这个版本
//   none       原样不动（本地反复验证同一个版本时用）
const fs = require('fs')
const path = require('path')

const PKG_PATH = path.resolve(__dirname, '..', 'package.json')
const SEMVER = /^\d+\.\d+\.\d+$/

function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim())
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null
}

/**
 * 算出下一个版本号。
 * @param current 当前版本（x.y.z）
 * @param arg     patch / minor / major / x.y.z / none，缺省按 patch
 * @returns 新版本号；none 时原样返回
 */
function nextVersion(current, arg) {
  const want = String(arg || 'patch').trim().toLowerCase()
  if (want === 'none' || want === 'keep') return current
  if (SEMVER.test(want)) return want
  if (want !== 'patch' && want !== 'minor' && want !== 'major') {
    throw new Error(`无法识别的版本参数：${arg}（可用 patch / minor / major / x.y.z / none）`)
  }
  const v = parse(current)
  if (!v) throw new Error(`package.json 里的版本号不是 x.y.z 形式：${current}`)
  if (want === 'major') return `${v.major + 1}.0.0`
  if (want === 'minor') return `${v.major}.${v.minor + 1}.0`
  return `${v.major}.${v.minor}.${v.patch + 1}`
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'))
  const current = String(pkg.version || '')
  let next
  try {
    next = nextVersion(current, process.argv[2])
  } catch (e) {
    console.error(`[version] ${e.message}`)
    process.exit(1)
  }

  if (next === current) {
    console.log(`[version] 保持 ${current}（未改动）`)
    return
  }
  pkg.version = next
  fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8')
  console.log(`[version] ${current} → ${next}`)
}

if (require.main === module) main()

module.exports = { nextVersion }
