import { defineConfig } from 'vite';

// 使用相对路径 base，使产物可直接托管在 GitHub Pages 子路径（https://<user>.github.io/<repo>/）下
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
  },
});
