import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ root: 'client', plugins: [react()], build: { outDir: 'dist' }, server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3001', '/events': 'http://127.0.0.1:3001' } } });
