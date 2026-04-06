import DefaultTheme from 'vitepress/theme'
import CommandsExplorer from './components/CommandsExplorer.vue'

export default {
  ...DefaultTheme,
  enhanceApp({ app }) {
    app.component('CommandsExplorer', CommandsExplorer)
  }
}
