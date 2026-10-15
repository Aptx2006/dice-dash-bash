<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ title: string; message: string; cancelLabel: string; confirmLabel: string }>()
const emit = defineEmits<{ cancel: []; confirm: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <dialog ref="dialog" class="confirm-dialog" :aria-label="title" @cancel.prevent="emit('cancel')">
    <h2>{{ title }}</h2>
    <p>{{ message }}</p>
    <div class="settlement-actions">
      <button type="button" class="pill-button" autofocus @click="emit('cancel')">{{ cancelLabel }}</button>
      <button type="button" class="pill-button primary" @click="emit('confirm')">{{ confirmLabel }}</button>
    </div>
  </dialog>
</template>
