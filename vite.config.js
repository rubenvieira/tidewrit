// vite.config.js
import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  // Self-signed HTTPS so WebGPU (secure-context only) works from other LAN devices.
  plugins: [basicSsl()],
  server: {
    allowedHosts: true
  }
})
