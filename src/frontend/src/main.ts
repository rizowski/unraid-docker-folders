import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/styles/main.css'
import { initBackend } from '@/backends'
import { applyThemeParam, reportHeightToParent } from './utils/iframeHost'
import { modalFrameFloor } from './composables/useModalElevation'

// The theme is applied before the await so the page is never briefly unstyled.
applyThemeParam()

// Pick the backend before anything can issue a request. GraphQL mode probes the
// plugin first, so mounting waits for it. A bootstrap function rather than a
// top-level await, which the build target does not allow.
async function bootstrap() {
  await initBackend()

  const app = createApp(App)
  app.use(createPinia())
  app.mount('#app')

  const appEl = document.getElementById('app')
  if (appEl) {
    // Keep the frame tall enough for an open modal, which the content height alone does not cover.
    const resendHeight = reportHeightToParent(appEl, () => modalFrameFloor.value)
    watch(modalFrameFloor, resendHeight)
  }
}

void bootstrap()
