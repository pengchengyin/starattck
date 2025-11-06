<script setup>
// 静态图例，无需逻辑
</script>

<template>
  <div class="legend">
    <div class="legend-title">图例</div>
    <div class="legend-list">
      <div class="legend-item">
        <span class="swatch" style="background:#ff0000"></span>
        <span class="label">端口扫描</span>
      </div>
      <div class="legend-item">
        <span class="swatch" style="background:#e74c3c"></span>
        <span class="label">远程代码执行 / SYN 洪泛攻击</span>
      </div>
      <div class="legend-item">
        <span class="swatch" style="background:#2ecc71"></span>
        <span class="label">WAF 阻断</span>
      </div>
      <div class="legend-item">
        <span class="swatch" style="background:#f39c12"></span>
        <span class="label">数据外泄</span>
      </div>
      <div class="legend-item">
        <span class="swatch" style="background:#9b59b6"></span>
        <span class="label">漏洞修复上线</span>
      </div>
    </div>
  </div>
  
</template>

<style scoped>
.legend {
  width: 280px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(255,255,255,0.08);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.15);
}
.legend-title {
  color: #cfe6ff;
  font-weight: 600;
  margin-bottom: 8px;
}
.legend-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.25);
}
.label {
  color: #e8f1ff;
  font-size: 13px;
}
</style>