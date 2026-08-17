import { defineConfig } from 'vite';

// 使用相对路径 base，使产物可直接托管在 GitHub Pages 子路径（https://<user>.github.io/<repo>/）下
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // 关闭自动清空：本环境的安全删除包装会拦截 fs.rmSync(dist)，导致构建失败
    emptyOutDir: false,
    // 飞书 SDK 体积较大，单独成包（vendor）以便浏览器长期缓存；预留告警阈值
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@lark-base-open/js-sdk')) {
            return 'feishu-sdk';
          }
        },
      },
    },
  },
});
