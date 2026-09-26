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
  // Isolated E2E runs override the port and API target; normal development keeps 5173 -> 3001.
  server: { port: Number(process.env.FRAMEFLOW_CLIENT_PORT ?? 5173), strictPort: true, proxy: { '/api': process.env.FRAMEFLOW_API_URL ?? 'http://127.0.0.1:3001' } },
});
