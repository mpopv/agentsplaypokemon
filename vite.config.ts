import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/admin": "http://127.0.0.1:8787",
      "/api": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
      "/ready": "http://127.0.0.1:8787",
      "/rooms": {
        target: "http://127.0.0.1:8787",
        ws: true
      }
    }
  }
});
