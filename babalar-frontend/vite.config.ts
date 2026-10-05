import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // tsc (no noEmit) leaves compiled .js next to the sources; prefer the TS sources over them.
    extensions: [".tsx", ".ts", ".mjs", ".js", ".jsx", ".json"],
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL || "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
