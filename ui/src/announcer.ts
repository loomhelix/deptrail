import { readonly, ref } from 'vue'

const message = ref('')

export const announcement = readonly(message)

export function announce(text: string): void {
  message.value = ''
  queueMicrotask(() => {
    message.value = text
  })
}
