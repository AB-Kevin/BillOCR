import { defineConfig } from "vite";

export default defineConfig({
  // Loaded via loadFile() (file://) in Electron, not a real server -- relative
  // asset paths are required, or the packaged build's <script>/<link> tags
  // resolve against the filesystem root and silently 404.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
