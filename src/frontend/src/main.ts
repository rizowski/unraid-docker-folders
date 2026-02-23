import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/styles/main.css'

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
