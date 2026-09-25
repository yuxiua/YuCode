import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import type http from 'node:http'

const devPortFile = path.resolve(__dirname, '.dev-port')

// 插件:Vite 开始监听后把实际端口写入 .dev-port,供 Electron 主进程读取。
// 这样即使 5173 被占用、Vite 自动换端口,窗口也不会连错。
function writeDevPort(): Plugin {
  const write = (httpServer: http.Server | null | undefined) => {
    try {
      const addr = httpServer?.address()
      if (addr && typeof addr === 'object' && addr.port) {
        fs.writeFileSync(devPortFile, String(addr.port), 'utf-8')
      }
    } catch {
      /* ignore */
    }
  }
  return {
    name: 'write-dev-port',
    apply: 'serve',
    configureServer(server) {
      // httpServer 可能尚未创建,监听 listening 事件兜底
      if (server.httpServer) {
        server.httpServer.once('listening', () => write(server.httpServer))
      }
      // post 钩子:dev server 完成监听后执行,此时地址已确定
      return () => write(server.httpServer)
    },
  }
}

export default defineConfig({
  plugins: [react(), writeDevPort()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
  server: {
    port: 5173,
    // 端口必须固定：localStorage 按 origin 隔离，一旦 5173 被占用 Vite 会静默换成 5174，
    // 新的 origin 相当于全新的存储，之前保存的工作区/对话/扩展就会"全都重置了"。
    // 被占用时宁可启动失败并报错，也不要悄悄换端口。
    strictPort: true,
    proxy: {
      '/api-proxy': {
        target: 'https://llm-i8qv3dd2zh3ezbd5.cn-beijing.maas.aliyuncs.com',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api-proxy/, '/compatible-mode/v1'),
      },
    },
  },
})
