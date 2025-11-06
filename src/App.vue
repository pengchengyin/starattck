<script setup>
import ThreeScene from './components/ThreeScene.vue'
import ControlPanel from './components/ControlPanel.vue'
</script>

<template>
  <div class="app-root">
    <ThreeScene />
    <ControlPanel class="panel" />
  </div>
</template>

<style scoped>
.app-root {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
.panel {
  position: absolute;
  right: 24px;
  top: 24px;
}
</style>
