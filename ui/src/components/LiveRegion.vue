<script setup lang="ts">
import { announcement } from '../announcer.ts'
</script>

<template>
  <p aria-live="polite" class="sr-only">{{ announcement }}</p>
</template>
