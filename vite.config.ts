import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const rawAllowed = env.PREVIEW_ALLOWED_HOSTS?.trim()

  let allowedHosts: true | string[] | undefined
  if (rawAllowed === 'true' || rawAllowed === '*') {
    allowedHosts = true
  } else if (rawAllowed) {
    allowedHosts = rawAllowed
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean)
  } else {
    // Match codezite so dynamic Cloud Run hostnames are accepted by default.
    allowedHosts = true
  }

  return {
    plugins: [react()],
    server: {
      port: 5173,
    },
    preview: {
      host: true,
      port: 8080,
      allowedHosts,
    },
    build: {
      outDir: 'dist',
    },
  }
})
