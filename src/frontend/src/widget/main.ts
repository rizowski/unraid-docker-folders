import { createApp } from 'vue'
import { createPinia } from 'pinia'
import WidgetApp from './WidgetApp.vue'
import '../assets/styles/main.css'
import { initBackend } from '@/backends'
import { applyThemeParam } from '../utils/iframeHost'

// The dashboard widget entry. WidgetApp reports its own height to the host
// page, because an open kebab menu has to hold the frame taller than the rows.
applyThemeParam()

// Pick the backend before anything can issue a request. See main.ts for why
// this is a function rather than a top-level await.
async function bootstrap() {
  await initBackend()

  const app = createApp(WidgetApp)
  app.use(createPinia())
  app.mount('#app')
}

void bootstrap()
