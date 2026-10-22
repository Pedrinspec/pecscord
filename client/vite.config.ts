import { defineConfig } from "vite";

// Em desenvolvimento, o Vite encaminha /ws para o servidor Rust.
export default defineConfig({
  server: {
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
