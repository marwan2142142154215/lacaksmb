import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { tempoVitePlugin } from "tempo-sdk";

// https://vite.dev/config/
export default defineConfig({
  plugins: [tempoVitePlugin(), react(), tailwindcss()],
});
