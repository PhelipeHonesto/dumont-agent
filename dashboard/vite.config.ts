import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@schemas": resolve(__dirname, "../src/schemas"),
    },
  },
  server: {
    port: 5174,
  },
});
