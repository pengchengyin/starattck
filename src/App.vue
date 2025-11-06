<script setup>
import ThreeScene from './components/ThreeScene.vue'
import ControlPanel from './components/ControlPanel.vue'
import AttackFeed from './components/AttackFeed.vue'
import Legend from './components/Legend.vue'
</script>

<template>
  <div class="app-root">
    <AttackFeed class="feed" />
    <ThreeScene />
    <ControlPanel class="panel" />
    <Legend class="legend" />
  </div>
</template>

<style scoped>
.app-root {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
.feed {
  position: absolute;
  left: 24px;
  top: 24px;
  z-index: 20;
}
.panel {
  position: absolute;
  right: 24px;
  top: 24px;
}
.legend {
  position: absolute;
  right: 24px;
  bottom: 24px;
  z-index: 20;
}
</style>
