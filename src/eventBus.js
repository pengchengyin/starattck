// 简易事件总线（避免额外依赖）
const listeners = new Map()

export function on(event, cb) {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(cb)
}

export function off(event, cb) {
  if (listeners.has(event)) listeners.get(event).delete(cb)
}

export function emit(event, payload) {
  if (!listeners.has(event)) return
  for (const cb of listeners.get(event)) {
    try { cb(payload) } catch (e) { console.error(e) }
  }
}

export default { on, off, emit }