import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/styles/main.css'
import { applyThemeParam, reportHeightToParent } from './utils/iframeHost'

applyThemeParam()

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.mount('#app')

const appEl = document.getElementById('app')
if (appEl) reportHeightToParent(appEl)
