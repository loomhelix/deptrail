import { onScopeDispose, ref, watch, type Ref } from 'vue'

const LOOKAHEAD_MARGIN = '200px'

export function useVisible(element: Ref<Element | null>): Ref<boolean> {
  const visible = ref(false)
  let observer: IntersectionObserver | undefined

  function stopObserving(): void {
    observer?.disconnect()
    observer = undefined
  }

  function markVisible(): void {
    visible.value = true
    stopObserving()
  }

  function observe(target: Element | null): void {
    stopObserving()
    if (target === null || visible.value) return
    if (typeof IntersectionObserver === 'undefined') {
      markVisible()
      return
    }
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) markVisible()
    }, { rootMargin: LOOKAHEAD_MARGIN })
    observer.observe(target)
  }

  watch(element, observe, { immediate: true, flush: 'post' })
  onScopeDispose(stopObserving)

  return visible
}
