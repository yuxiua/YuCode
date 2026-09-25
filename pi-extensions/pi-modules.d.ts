/**
 * 给编辑器补的两个模块声明。
 *
 * typebox 与 @earendil-works/pi-coding-agent 只有 pi 运行时才有：
 * 前者 vendored 在 vendor/pi 的 pi 包内部，后者是 pi 自己；
 * 扩展被 pi 加载时，这两个名字由 pi 的 jiti alias 注入解析（见 pi 的
 * dist/core/extensions/loader.js getAliases()）。仓库里既没有、也不该有这两个包，
 * 所以这里补一份最小声明，让源码不给 IDE 冒「找不到模块」的红线 ——
 * 它只影响编辑器/类型检查，运行时不经过这里。
 */

declare module "typebox" {
  export const Type: any
}

declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any
}
