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

// Notify parent frame of content height changes for iframe auto-resize.
// Observe #app (not documentElement) and use offsetHeight (not scrollHeight)
// so the iframe can shrink when folders collapse — scrollHeight on <html>
// never decreases because <html> fills the iframe's current (stale) height.
if (window.parent !== window) {
  const appEl = document.getElementById('app')
  if (appEl) {
    const sendHeight = () => {
      window.parent.postMessage(
        { type: 'docker-folders-resize', height: appEl.offsetHeight },
        '*'
      )
    }
    new ResizeObserver(sendHeight).observe(appEl)
    sendHeight()
  }
}
