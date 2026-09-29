import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/plugin.ts", "src/capture-server.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  shims: true,
})
