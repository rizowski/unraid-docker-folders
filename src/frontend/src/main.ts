import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/styles/main.css'
import { applyThemeParam, reportHeightToParent } from './utils/iframeHost'
import { modalFrameFloor } from './composables/useModalElevation'

applyThemeParam()

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.mount('#app')

const appEl = document.getElementById('app')
if (appEl) {
  // Keep the frame tall enough for an open modal, which the content height alone does not cover.
  const resendHeight = reportHeightToParent(appEl, () => modalFrameFloor.value)
  watch(modalFrameFloor, resendHeight)
}
