<script setup lang="ts">
defineProps<{ messages: readonly string[] }>()
</script>

<template>
  <div v-if="messages.length > 0" class="notice-banner" role="alert">
    <p v-for="(message, position) in messages" :key="`${position}\n${message}`" class="notice-banner__message">{{ message }}</p>
  </div>
</template>

<style scoped>
.notice-banner {
  display: grid;
  flex: none;
  gap: 4px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  border-left: 4px solid var(--danger);
  background: var(--badge-danger-bg);
  color: var(--badge-danger-fg);
}

.notice-banner__message {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
