// 持久化后端：主进程的文件存储（userData/yu-code-state.json）。
//
// 之前用 localStorage，问题是它按 origin 隔离——
// dev 模式端口一变（5173→5174）、或从 dev 换成打包版（file://），
// 数据就落在不同的存储桶里，表现为"工作区/对话/扩展全被重置"；
// 而且有 5~10MB 上限，对话一长就可能写不进去。
//
// 这里保持 localStorage 风格的同步读写（getItem/setItem/removeItem），
// 读走启动时同步取到的内存快照，写回主进程做防抖落盘。
const FILE_STATE: Record<string, string> =
  (window.piAPI?.initialState as Record<string, string> | undefined) ?? {}

/** 只接管 pi- 前缀的 key，避免误动其他来源的数据 */
const KEY_PREFIX = 'pi-'

const cache = new Map<string, string>()

for (const [key, value] of Object.entries(FILE_STATE)) {
  if (typeof value === 'string') cache.set(key, value)
}

// 升级遗留：旧版会话用「全局」key 存储，会让每个目录都看到同一批历史；
// __default__ 则是没有目录概念时落下的默认桶。这些已无人读取，清掉。
const DEAD_KEYS = [
  'pi-chat-tabs',
  'pi-active-tab',
  'pi-chat-tabs::__default__',
  'pi-chat-active-tab::__default__',
]

// 首次使用文件存储时，把 localStorage 里的旧数据搬过来，避免用户历史丢失。
// 只在文件存储为空时执行：否则文件里已删除的 key 会被 localStorage 的旧副本反复搬回。
let migrated = false
function migrateFromLocalStorage() {
  if (migrated) return
  migrated = true
  try {
    for (const key of DEAD_KEYS) {
      localStorage.removeItem(key)
      if (cache.has(key)) {
        cache.delete(key)
        window.piAPI?.saveState?.({ [key]: null })
      }
    }
    if (Object.keys(FILE_STATE).length > 0) return
    const moved: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(KEY_PREFIX) || cache.has(key)) continue
      const value = localStorage.getItem(key)
      if (value === null) continue
      cache.set(key, value)
      moved[key] = value
    }
    if (Object.keys(moved).length > 0) window.piAPI?.saveState?.(moved)
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
migrateFromLocalStorage()

export const storage = {
  getItem(key: string): string | null {
    return cache.has(key) ? (cache.get(key) as string) : null
  },
  setItem(key: string, value: string): void {
    cache.set(key, value)
    window.piAPI?.saveState?.({ [key]: value })
  },
  removeItem(key: string): void {
    cache.delete(key)
    window.piAPI?.saveState?.({ [key]: null })
  },
}
