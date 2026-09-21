import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'canvas', test: /node_modules\/(konva|react-konva|react-reconciler)\// }] } },
    },
  },
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001' } },
});
