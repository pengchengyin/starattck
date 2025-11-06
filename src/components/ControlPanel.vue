<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { emit } from '../eventBus'

function trigger(type) {
  // 手动触发也带上当前模式，便于统一效果强度
  emit('attack:trigger', { type, mode: autoMode.value })
}

const autoEnabled = ref(true)
let autoTimer = null
const TYPES = ['abnormal', 'compromise', 'defense', 'ddos', 'exfiltration', 'patch']
const autoMode = ref('normal') // normal | berserk

function scheduleNext() {
  // 根据模式调整触发频率：普通 2.0～5.0s，狂暴 0.4～1.0s
  const delay = autoMode.value === 'berserk'
    ? 400 + Math.floor(Math.random() * 600)
    : 2000 + Math.floor(Math.random() * 3000)
  autoTimer = setTimeout(() => {
    const type = TYPES[Math.floor(Math.random() * TYPES.length)]
    emit('attack:trigger', { type, mode: autoMode.value })
    if (autoEnabled.value) scheduleNext()
  }, delay)
}

function startAuto() {
  if (autoTimer) clearTimeout(autoTimer)
  scheduleNext()
}

function stopAuto() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
}

watch(autoEnabled, (on) => {
  if (on) startAuto(); else stopAuto()
}, { immediate: true })

onMounted(() => {
  // 防御性保障：如果默认开启但 watcher 未触发，主动启动
  if (autoEnabled.value) startAuto()
})

onBeforeUnmount(() => {
  stopAuto()
})
</script>

<template>
  <div class="panel">
    <div class="panel-title">攻击事件控制</div>
    <div class="auto-row">
      <label class="auto-toggle">
        <input type="checkbox" v-model="autoEnabled" />
        <span>自动随机发起攻击事件</span>
      </label>
    </div>
    <div class="mode-row">
      <label class="mode-option">
        <input type="radio" name="auto-mode" value="normal" v-model="autoMode" />
        <span>普通模式</span>
      </label>
      <label class="mode-option">
        <input type="radio" name="auto-mode" value="berserk" v-model="autoMode" />
        <span>狂暴模式</span>
      </label>
    </div>
    <div class="btns">
      <button class="btn" @click="trigger('abnormal')">异常流量检测</button>
      <button class="btn" @click="trigger('compromise')">节点攻陷</button>
      <button class="btn" @click="trigger('defense')">防御系统激活</button>
      <button class="btn" @click="trigger('ddos')">DDoS 攻击</button>
      <button class="btn" @click="trigger('exfiltration')">信息窃取</button>
      <button class="btn" @click="trigger('patch')">漏洞修复</button>
    </div>
  </div>
</template>

<style scoped>
.panel {
  width: 320px;
  padding: 16px;
  border-radius: 12px;
  background: rgba(255,255,255,0.08);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.15);
}
.panel-title {
  color: #cfe6ff;
  font-weight: 600;
  margin-bottom: 8px;
}
.auto-row {
  display: flex;
  align-items: center;
  margin-bottom: 10px;
}
.mode-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
}
.mode-option {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #e8f1ff;
}
.mode-option input { transform: scale(1.05); }
.auto-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #e8f1ff;
}
.auto-toggle input {
  transform: scale(1.1);
}
.btns {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}
.btn {
  height: 36px;
  border: 1px solid rgba(180,200,255,0.3);
  border-radius: 8px;
  color: #e8f1ff;
  background: rgba(80,120,255,0.15);
  cursor: pointer;
}
.btn:hover {
  border-color: rgba(180,200,255,0.6);
  background: rgba(80,120,255,0.25);
}
</style>