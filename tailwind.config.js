/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        pi: {
          // 更深的近黑底 + 米白文字，保证长文本可读性
          bg: '#141414',
          surface: '#1c1c1c',
          border: '#2f2f2f',
          accent: '#89b4fa',
          'accent-dim': '#74c7ec',
          text: '#e7e4df',
          'text-muted': '#a6a6a6',
          'text-dim': '#787878',
          hover: '#272727',
          selected: '#1e3a5f',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'scan': 'scan 2s linear infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        scan: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
}
