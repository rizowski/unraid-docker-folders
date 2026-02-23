import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/styles/main.css'

// Apply Unraid theme CSS variables passed from parent iframe host
const themeParam = new URLSearchParams(window.location.search).get('theme')
if (themeParam) {
  try {
    const vars = JSON.parse(themeParam) as Record<string, string>
    const root = document.documentElement
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value)
    }
  } catch {
    // Ignore malformed theme param
  }
}

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.mount('#app')

// Notify parent frame of content height changes for iframe auto-resize
if (window.parent !== window) {
  const sendHeight = () => {
    window.parent.postMessage(
      { type: 'docker-folders-resize', height: document.documentElement.scrollHeight },
      '*'
    )
  }
  new ResizeObserver(sendHeight).observe(document.documentElement)
  sendHeight()
}
