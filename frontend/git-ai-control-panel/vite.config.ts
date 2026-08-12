import fs from "node:fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const controlPanelVersion = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
).version
const controlPanelUpdatedAt = new Date().toISOString()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __CONTROL_PANEL_VERSION__: JSON.stringify(controlPanelVersion),
    __CONTROL_PANEL_UPDATED_AT__: JSON.stringify(controlPanelUpdatedAt),
  },
  build: {
    outDir: "../../static",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
