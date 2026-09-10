/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        app: '#F6F7F9',
        surface: '#FFFFFF',
        surface2: '#F1F3F5',
        line: '#D9DEE5',
        ink: '#1A1C21',
        ink2: '#62666F',
        accent: '#0078D4',
        accentsoft: '#E8F1FB',
        ok: '#178A4D',
        warn: '#C76C00',
        err: '#C42B1C',
      },
      fontFamily: {
        sans: ['"Noto Sans SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Mono"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      borderRadius: { card: '10px', ctl: '8px' },
    },
  },
  plugins: [],
};