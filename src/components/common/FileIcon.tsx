import type { ReactNode } from 'react'

// ─── 文件类型图标（左侧文件树与编辑器标签栏共用）──────────────────────────────
//
// 之前左侧文件树用内联 SVG、编辑器标签栏用 emoji（.py 显示 🐍），同一个文件
// 在两处长得不一样。这里收敛成唯一一份实现，两边都渲染这个组件。

export default function FileIcon({
  name,
  isDirectory,
  expanded,
}: {
  name: string
  isDirectory: boolean
  expanded?: boolean
}) {
  if (isDirectory) {
    return expanded ? (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M1.5 3.5C1.5 2.9477 1.9477 2.5 2.5 2.5H5.3787L6.8787 4H13.5C14.0523 4 14.5 4.4477 14.5 5V6H2.5L1.5 13V3.5Z" fill="#4a8fd4" opacity="0.9"/>
        <path d="M1.5 13H14.5L13.5 6H2.5L1.5 13Z" fill="#5ba0e0"/>
      </svg>
    ) : (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M2 4C2 3.44772 2.44772 3 3 3H6.2L7.5 4.5H13C13.5523 4.5 14 4.94772 14 5.5V11.5C14 12.0523 13.5523 12.5 13 12.5H3C2.44772 12.5 2 12.0523 2 11.5V4Z" fill="#4a8fd4"/>
      </svg>
    )
  }

  const ext = name.split('.').pop()?.toLowerCase() || ''

  const iconMap: Record<string, ReactNode> = {
    ts: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#3178c6"/>
        <text x="8" y="11" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="bold" fontFamily="system-ui">TS</text>
      </svg>
    ),
    tsx: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#3178c6"/>
        <text x="8" y="11" textAnchor="middle" fill="#61dafb" fontSize="6.5" fontWeight="bold" fontFamily="system-ui">TSX</text>
      </svg>
    ),
    js: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#f7df1e"/>
        <text x="8" y="11" textAnchor="middle" fill="#1a1a1a" fontSize="7" fontWeight="bold" fontFamily="system-ui">JS</text>
      </svg>
    ),
    jsx: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#f7df1e"/>
        <text x="8" y="11" textAnchor="middle" fill="#1a1a1a" fontSize="6" fontWeight="bold" fontFamily="system-ui">JSX</text>
      </svg>
    ),
    py: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#3776ab"/>
        <text x="8" y="11.3" textAnchor="middle" fill="#fff" fontSize="7.5" fontWeight="bold" fontFamily="Inter, Segoe UI, sans-serif">PY</text>
      </svg>
    ),
    json: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#e8a020"/>
        <text x="8" y="11.5" textAnchor="middle" fill="#fff" fontSize="8" fontWeight="bold" fontFamily="monospace">{'</>'}</text>
      </svg>
    ),
    md: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#8b5cf6"/>
        <text x="8" y="11" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="bold" fontFamily="system-ui">M↓</text>
      </svg>
    ),
    html: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#e44d26"/>
        <text x="8" y="11.5" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="bold" fontFamily="monospace">{'</>'}</text>
      </svg>
    ),
    css: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#563d7c"/>
        <text x="8" y="12" textAnchor="middle" fill="#fff" fontSize="9" fontWeight="bold" fontFamily="monospace">#</text>
      </svg>
    ),
    png: <ImageIcon/>,
    jpg: <ImageIcon/>,
    jpeg: <ImageIcon/>,
    gif: <ImageIcon/>,
    svg: <ImageIcon/>,
    webp: <ImageIcon/>,
    zip: <ArchiveIcon/>,
    tar: <ArchiveIcon/>,
    gz: <ArchiveIcon/>,
    rar: <ArchiveIcon/>,
    '7z': <ArchiveIcon/>,
    sh: <TerminalIcon/>,
    bat: <TerminalIcon/>,
    toml: <ConfigIcon/>,
    yml: <ConfigIcon/>,
    yaml: <ConfigIcon/>,
    rs: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#c9435e"/>
        <circle cx="8" cy="8" r="3" stroke="#fff" strokeWidth="1.2" fill="none"/>
        <circle cx="8" cy="8" r="1" fill="#fff"/>
      </svg>
    ),
    go: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#00add8"/>
        <circle cx="8" cy="8" r="3.5" stroke="#fff" strokeWidth="1" fill="none"/>
        <path d="M5.5 8L8 5.5L10.5 8" stroke="#fff" strokeWidth="1" strokeLinecap="round"/>
      </svg>
    ),
    java: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#5382a1"/>
        <path d="M6 4C5.5 4.5 5.5 5.5 6 6C6.5 6.5 6.5 7.5 6 8H8C7.5 7.5 7.5 6.5 8 6C8.5 5.5 8.5 4.5 8 4H6Z" fill="#e76f00" opacity="0.9"/>
        <rect x="5" y="8.5" width="6" height="1.5" rx="0.5" fill="#e76f00"/>
        <rect x="6" y="10.5" width="4" height="1" rx="0.5" fill="#e76f00" opacity="0.7"/>
      </svg>
    ),
    vue: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#35495e"/>
        <path d="M3 4L8 12L13 4H11L8 8.5L5 4H3Z" fill="#41b883"/>
        <path d="M5 4L8 8.5L11 4H9.5L8 6L6.5 4H5Z" fill="#41b883" opacity="0.5"/>
      </svg>
    ),
  }

  const icon = iconMap[ext]
  if (icon) return icon

  // 默认：通用文件图标
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M4 2.5C4 1.9477 4.4477 1.5 5 1.5H9.5L12 4V13.5C12 14.0523 11.5523 14.5 11 14.5H5C4.4477 14.5 4 14.0523 4 13.5V2.5Z" fill="#6b7280" opacity="0.7"/>
      <path d="M9.5 1.5V4H12" fill="none" stroke="#4b5563" strokeWidth="0.5"/>
      <path d="M5.5 7H10.5M5.5 9H10.5M5.5 11H8.5" stroke="#9ca3af" strokeWidth="0.8" strokeLinecap="round"/>
    </svg>
  )
}

function ImageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect width="16" height="16" rx="3" fill="#10b981"/>
      <rect x="3" y="4" width="10" height="8" rx="1" fill="none" stroke="#fff" strokeWidth="1"/>
      <circle cx="6" cy="7" r="1" fill="#fff"/>
      <path d="M3 11L6 8.5L8 10.5L10.5 7.5L13 11" stroke="#fff" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  )
}

function ArchiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect width="16" height="16" rx="3" fill="#a78bfa"/>
      <rect x="4" y="5" width="8" height="8" rx="1" fill="none" stroke="#fff" strokeWidth="1"/>
      <path d="M4 5L5 3H11L12 5" stroke="#fff" strokeWidth="1" strokeLinejoin="round" fill="none"/>
      <rect x="6.5" y="7" width="3" height="1.5" rx="0.5" fill="#fff" opacity="0.7"/>
      <rect x="6.5" y="9.5" width="3" height="1.5" rx="0.5" fill="#fff" opacity="0.4"/>
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect width="16" height="16" rx="3" fill="#374151"/>
      <path d="M4 5.5L6.5 8L4 10.5" stroke="#4ade80" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M7.5 11H11.5" stroke="#4ade80" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  )
}

function ConfigIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect width="16" height="16" rx="3" fill="#6366f1"/>
      <circle cx="8" cy="8" r="2.5" stroke="#fff" strokeWidth="1" fill="none"/>
      <path d="M8 4V5.5M8 10.5V12M4 8H5.5M10.5 8H12" stroke="#fff" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  )
}
