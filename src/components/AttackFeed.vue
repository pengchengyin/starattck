<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import bus, { on, off } from '../eventBus'

const items = ref([])
const maxItems = 100

  function pushItem(evt) {
    const ts = evt?.ts ?? Date.now()
    const time = new Date(ts).toLocaleTimeString()
    const labelMap = {
      abnormal: '端口扫描',
      compromise: '远程代码执行',
      defense: 'WAF 阻断',
      ddos: 'SYN 洪泛攻击',
      exfiltration: '数据外泄',
      patch: '漏洞修复上线',
    }
    const title = `${labelMap[evt?.type] || evt?.type || '未知事件'}`
    const gatewayName = evt?.gateway?.name || '未知地点'
    const ip = evt?.terminal?.ip || evt?.gateway?.ip || '-'
    const id = evt?.id || `${ts}-${Math.random().toString(36).slice(2,7)}`
    const item = { id, time, title, gatewayName, ip }
  // 在行首插入，并保留最多 maxItems 条
  items.value.unshift(item)
  if (items.value.length > maxItems) items.value.length = maxItems
}

onMounted(() => {
  on('attack:started', pushItem)
})

onBeforeUnmount(() => {
  off('attack:started', pushItem)
})
</script>

<template>
  <div class="feed">
    <div class="feed-title">攻击事件信息</div>
    <div class="feed-list">
      <div v-if="items.length === 0" class="feed-empty">暂无事件，触发后将显示在这里</div>
      <div v-for="it in items" :key="it.id" class="feed-item">
        <div class="row1">
          <span class="time">{{ it.time }}</span>
          <span class="title">{{ it.title }}</span>
        </div>
        <div class="row2">
          <span class="meta">地点：{{ it.gatewayName }}</span>
          <span class="meta">终端：{{ it.ip }}</span>
        </div>
      </div>
    </div>
  </div>
  
</template>

<style scoped>
.feed {
  width: 360px;
  padding: 16px;
  border-radius: 12px;
  background: rgba(255,255,255,0.08);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.15);
}
.feed-title {
  color: #cfe6ff;
  font-weight: 600;
  margin-bottom: 8px;
}
.feed-empty {
  color: #c5d7f2;
  font-size: 12px;
}
.feed-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow: auto; /* 保留滚动能力 */
  /* 隐藏滚动条（Firefox/IE/Edge） */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.feed-item {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(40,60,120,0.25);
  border: 1px solid rgba(160,190,255,0.2);
}
.row1 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.time {
  color: #9fb8d9;
  font-size: 12px;
}
.title {
  color: #e8f1ff;
  font-weight: 600;
}
.row2 {
  display: flex;
  justify-content: space-between;
}
.meta {
  color: #c5d7f2;
  font-size: 12px;
}

/* WebKit(Chrome/Edge/Safari) 隐藏滚动条 */
.feed-list::-webkit-scrollbar {
  width: 0;
  height: 0;
}
</style>