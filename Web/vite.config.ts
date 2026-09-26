import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Export Vite config. DEV_FUNCTION_HOST allows dev to proxy /api to a remote function app
// without running the backend locally. Defaults to http://localhost:7071 for local dev.
const devFunctionHost = process.env.DEV_FUNCTION_HOST || "http://localhost:7071";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: devFunctionHost,
        changeOrigin: true,
      },
    },
  },
});
