import { createApp } from 'vue'
import App from './App.vue'
import { createApi, setApiSource } from './api.ts'
import { openShownSource, reloadForDroppedSource, SHOWN_SOURCE } from './source.ts'

function sessionStorageOrNone(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

function reloadDroppedSource(): void {
  reloadForDroppedSource(sessionStorageOrNone(), Date.now(), () => window.location.reload())
}

void openShownSource(createApi(), window.location.search).then((state) => {
  if (state.source.kind === 'commit') setApiSource(state.source.commit, reloadDroppedSource)
  createApp(App).provide(SHOWN_SOURCE, state).mount('#app')
})
