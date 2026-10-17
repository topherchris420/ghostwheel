import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        '**/src-tauri/**',
        '**/.build/**',
        '**/evidence/**',
        '**/backend/**',
        '**/release/**',
      ],
    },
  },
  build: { target: 'es2022' },
  clearScreen: false,
});
