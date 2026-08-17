import { defineConfig } from 'vite';

// 使用相对路径 base，使产物可直接托管在 GitHub Pages 子路径（https://<user>.github.io/<repo>/）下
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // 关闭自动清空：本环境的安全删除包装会拦截 fs.rmSync(dist)，导致构建失败
    emptyOutDir: false,
  },
});
