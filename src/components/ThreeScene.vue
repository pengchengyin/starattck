<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import bus from '../eventBus'

// 物理与尺度设定
const EARTH_RADIUS_KM = 6371
const WORLD_R_SCALE = 100 // 场景中地球半径（世界单位）
const SCALE = WORLD_R_SCALE / EARTH_RADIUS_KM // km -> world units
// 可视化加速因子：放大时间进度以便肉眼观察到卫星转动
const SIM_SPEED = 40

const containerRef = ref(null)

let renderer, scene, camera, controls, animationId
let earthMesh
let geoRingRef, lowRingRef
const gltfLoader = new GLTFLoader()
const SAT_MODEL_MAP = {
  geo: '/GEO_Satellite.glb',
  high: '/High_Orbit_Satellite.glb',
  low: '/GEO_Satellite.glb',
  inclined: '/High_Orbit_Satellite.glb',
  polar: '/GEO_Satellite.glb',
}
// 地点 -> 公网 IP 映射（示例值，可按需调整为真实网段）
const GATEWAY_IP_MAP = {
  Beijing: '36.110.10.20',
  London: '51.140.26.5',
  NewYork: '23.23.114.1',
  Sydney: '101.0.76.12'
}
const SAT_VISUAL_MAX = 20 // 统一的可视最大边尺寸，显著增大以提升可见性
let hudGroup
let orbitGroup
let satGroups = []
let gatewayGroup, terminalGroup
let gateways = []
let terminals = []
let effects = []
let flyLines = []

const SURFACE_OFFSET = 0 // 贴合球面；如需略微抬升可调为 0.5~1
function getEarthScale() { return earthMesh?.scale?.x ?? 1 }
function worldToEarthLocal(posWorld) {
  const s = getEarthScale()
  return posWorld.clone().divideScalar(Math.max(s, 1e-6))
}

function kmToWorld(km) { return km * SCALE }

function createOrbitRing(radiusWorld, tiltAxis = new THREE.Vector3(0,0,1), tiltRad = 0, color = 0x4477aa) {
  const segments = 256
  const circle = new THREE.BufferGeometry()
  const positions = new Float32Array((segments + 1) * 3)
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2
    positions[i*3] = Math.cos(t) * radiusWorld
    positions[i*3+1] = 0
    positions[i*3+2] = Math.sin(t) * radiusWorld
  }
  circle.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 })
  const line = new THREE.Line(circle, mat)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  q.setFromAxisAngle(tiltAxis.normalize(), tiltRad)
  m.makeRotationFromQuaternion(q)
  line.applyMatrix4(m)
  return line
}

// 椭圆轨道线（a、b 半轴），用于与椭圆轨道的卫星路径准确对齐
function createEllipseRing(aWorld, bWorld, tiltAxis = new THREE.Vector3(1,0,0), tiltRad = 0, color = 0x4477aa) {
  const segments = 256
  const geom = new THREE.BufferGeometry()
  const positions = new Float32Array((segments + 1) * 3)
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2
    positions[i*3] = Math.cos(t) * aWorld
    positions[i*3+1] = 0
    positions[i*3+2] = Math.sin(t) * bWorld
  }
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 })
  const line = new THREE.Line(geom, mat)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  q.setFromAxisAngle(tiltAxis.normalize(), tiltRad)
  m.makeRotationFromQuaternion(q)
  line.applyMatrix4(m)
  return line
}

// 构建椭圆的弧长查找表，便于等弧长分布与匀速运动
function buildEllipseArcTable(aWorld, bWorld, segments = 2048) {
  const tArr = new Float32Array(segments + 1)
  const sArr = new Float32Array(segments + 1)
  let total = 0
  let prev = new THREE.Vector3(aWorld, 0, 0)
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2
    tArr[i] = t
    const curr = new THREE.Vector3(Math.cos(t) * aWorld, 0, Math.sin(t) * bWorld)
    if (i > 0) {
      total += curr.distanceTo(prev)
    }
    sArr[i] = total
    prev = curr
  }
  return { t: tArr, s: sArr, total }
}

// 根据目标弧长在查表中二分找到对应参数 t，并做线性插值
function findTForArcLength(table, sTarget) {
  const { t, s, total } = table
  let sNorm = sTarget % total
  if (sNorm < 0) sNorm += total
  // 二分查找
  let lo = 0, hi = s.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (s[mid] < sNorm) lo = mid + 1
    else hi = mid
  }
  const i = Math.max(1, lo)
  const s0 = s[i-1], s1 = s[i]
  const t0 = t[i-1], t1 = t[i]
  const ratio = s1 === s0 ? 0 : (sNorm - s0) / (s1 - s0)
  return t0 + (t1 - t0) * ratio
}

function createSatellitesOnCircularOrbit(radiusWorld, count, tiltAxis, tiltRad, color) {
  const geom = new THREE.SphereGeometry(1, 8, 8)
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 })
  const mesh = new THREE.InstancedMesh(geom, mat, count)
  const baseMatrix = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  q.setFromAxisAngle(tiltAxis.normalize(), tiltRad)
  const rotMat = new THREE.Matrix4().makeRotationFromQuaternion(q)
  const temp = new THREE.Object3D()
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2
    temp.position.set(Math.cos(t) * radiusWorld, 0, Math.sin(t) * radiusWorld)
    temp.updateMatrix()
    baseMatrix.copy(temp.matrix)
    baseMatrix.multiply(rotMat)
    mesh.setMatrixAt(i, baseMatrix)
  }
  mesh.instanceMatrix.needsUpdate = true
  return mesh
}

function createSatellitesOnEllipticOrbit(aWorld, bWorld, count, tiltAxis, tiltRad, color) {
  const geom = new THREE.SphereGeometry(1, 8, 8)
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 })
  const mesh = new THREE.InstancedMesh(geom, mat, count)
  const baseMatrix = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  q.setFromAxisAngle(tiltAxis.normalize(), tiltRad)
  const rotMat = new THREE.Matrix4().makeRotationFromQuaternion(q)
  const temp = new THREE.Object3D()
  // 使用椭圆弧长表，确保初始分布等弧长
  const table = buildEllipseArcTable(aWorld, bWorld)
  for (let i = 0; i < count; i++) {
    const sTarget = table.total * (i / count)
    const tParam = findTForArcLength(table, sTarget)
    temp.position.set(Math.cos(tParam) * aWorld, 0, Math.sin(tParam) * bWorld)
    temp.updateMatrix()
    baseMatrix.copy(temp.matrix)
    baseMatrix.multiply(rotMat)
    mesh.setMatrixAt(i, baseMatrix)
  }
  mesh.instanceMatrix.needsUpdate = true
  return mesh
}

function init() {
  const container = containerRef.value
  const w = container.clientWidth
  const h = container.clientHeight

  // 渲染器
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 1) // 深空黑背景
  container.appendChild(renderer.domElement)

  // 场景
  scene = new THREE.Scene()

  // 相机
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 5000)
  camera.position.set(0, WORLD_R_SCALE * 2.5, WORLD_R_SCALE * 2.5)

  // 灯光
  const ambient = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambient)
  const dir = new THREE.DirectionalLight(0xffffff, 0.8)
  dir.position.set(WORLD_R_SCALE * 2, WORLD_R_SCALE, WORLD_R_SCALE)
  scene.add(dir)

  // 轨道控制，带阻尼
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = WORLD_R_SCALE * 1.2
  controls.maxDistance = WORLD_R_SCALE * 10
  controls.enablePan = false

  // 地球网格（占位，无贴图）+ LOD（作为加载 GLB 的兜底）
  const mat = new THREE.MeshPhongMaterial({ color: 0x223355, shininess: 15 })
  const lod = new THREE.LOD()
  const high = new THREE.Mesh(new THREE.SphereGeometry(WORLD_R_SCALE, 64, 64), mat)
  const mid = new THREE.Mesh(new THREE.SphereGeometry(WORLD_R_SCALE, 24, 24), mat)
  lod.addLevel(high, WORLD_R_SCALE * 0)
  lod.addLevel(mid, WORLD_R_SCALE * 3)
  earthMesh = lod
  scene.add(lod)

  // 轻微星空（点云）
  const stars = new THREE.BufferGeometry()
  const starCnt = 1000
  const positions = new Float32Array(starCnt * 3)
  for (let i = 0; i < starCnt; i++) {
    const r = WORLD_R_SCALE * 20
    positions[i * 3] = (Math.random() * 2 - 1) * r
    positions[i * 3 + 1] = (Math.random() * 2 - 1) * r
    positions[i * 3 + 2] = (Math.random() * 2 - 1) * r
  }
  stars.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.8, transparent: true, opacity: 0.6 })
  const starField = new THREE.Points(stars, starMat)
  scene.add(starField)

  // HUD 元素：坐标轴与网格（科技感参考）
  hudGroup = new THREE.Group()
  const axes = new THREE.AxesHelper(WORLD_R_SCALE * 1.2)
  axes.material.depthTest = false
  axes.renderOrder = 10
  axes.visible = false // 隐藏坐标轴辅助
  hudGroup.add(axes)
  const grid = new THREE.GridHelper(WORLD_R_SCALE * 6, 24, 0x224466, 0x112233)
  grid.material.transparent = true
  grid.material.opacity = 0.2
  grid.position.y = -WORLD_R_SCALE * 1.3
  hudGroup.add(grid)
  scene.add(hudGroup)

  // 轨道系统组
  orbitGroup = new THREE.Group()
  scene.add(orbitGroup)

  // 同步轨道: 赤道平面
  const geoAlt = kmToWorld(35786)
  const geoRadius = WORLD_R_SCALE + geoAlt
  const geoRing = createOrbitRing(geoRadius, new THREE.Vector3(1,0,0), 0, 0x99ccff)
  orbitGroup.add(geoRing); geoRingRef = geoRing
  const geoSats = createSatellitesOnCircularOrbit(geoRadius, 24, new THREE.Vector3(1,0,0), 0, 0x88bbff)
  orbitGroup.add(geoSats)
  satGroups.push({ type: 'geo', mesh: geoSats, radius: geoRadius, tiltAxis: new THREE.Vector3(1,0,0), tilt: 0, speed: 0.0000727, count: geoSats.count }) // 2π/86164 ~ 7.29e-5 rad/s

  // 高轨道: 圆形，取中位高度
  const highAlt = kmToWorld(27500)
  const highRadius = WORLD_R_SCALE + highAlt
  const highRing = createOrbitRing(highRadius, new THREE.Vector3(1,0,0), Math.PI/6, 0x66aaff)
  orbitGroup.add(highRing)
  const highSats = createSatellitesOnCircularOrbit(highRadius, 36, new THREE.Vector3(1,0,0), Math.PI/6, 0x66aaff)
  orbitGroup.add(highSats)
  satGroups.push({ type: 'high', mesh: highSats, radius: highRadius, tiltAxis: new THREE.Vector3(1,0,0), tilt: Math.PI/6, speed: 0.00012, count: highSats.count })

  // 低轨道: 圆形，取中位高度
  const lowAlt = kmToWorld(1250)
  const lowRadius = WORLD_R_SCALE + lowAlt
  const lowRing = createOrbitRing(lowRadius, new THREE.Vector3(1,0,0), Math.PI/4, 0x55aadd)
  orbitGroup.add(lowRing); lowRingRef = lowRing
  const lowSats = createSatellitesOnCircularOrbit(lowRadius, 24, new THREE.Vector3(1,0,0), Math.PI/4, 0x55aadd)
  orbitGroup.add(lowSats)
  satGroups.push({ type: 'low', mesh: lowSats, radius: lowRadius, tiltAxis: new THREE.Vector3(1,0,0), tilt: Math.PI/4, speed: 0.00035, count: lowSats.count })

  // 倾斜轨道: 45°倾角的椭圆
  const aAlt = kmToWorld(20000)
  const bAlt = kmToWorld(12000)
  const a = WORLD_R_SCALE + aAlt
  const b = WORLD_R_SCALE + bAlt
  // 使用椭圆轨道线，并围绕 X 轴倾斜 45°
  const inclineRing = createEllipseRing(a, b, new THREE.Vector3(1,0,0), Math.PI/4, 0x88ccff)
  orbitGroup.add(inclineRing)
  const inclineArcTable = buildEllipseArcTable(a, b)
  const inclineSats = createSatellitesOnEllipticOrbit(a, b, 16, new THREE.Vector3(1,0,0), Math.PI/4, 0x88ccff)
  orbitGroup.add(inclineSats)
  satGroups.push({ type: 'inclined', mesh: inclineSats, a, b, tiltAxis: new THREE.Vector3(1,0,0), tilt: Math.PI/4, speed: 0.00018, arcTable: inclineArcTable, count: inclineSats.count })

  // 极地轨道: 90°倾角的圆形
  const polarAlt = kmToWorld(1000)
  const polarRadius = WORLD_R_SCALE + polarAlt
  // 围绕 X 轴倾斜 90°，使轨道平面垂直于赤道
  const polarRing = createOrbitRing(polarRadius, new THREE.Vector3(1,0,0), Math.PI/2, 0x77bbff)
  orbitGroup.add(polarRing)
  const polarSats = createSatellitesOnCircularOrbit(polarRadius, 20, new THREE.Vector3(1,0,0), Math.PI/2, 0x77bbff)
  orbitGroup.add(polarSats)
  satGroups.push({ type: 'polar', mesh: polarSats, radius: polarRadius, tiltAxis: new THREE.Vector3(1,0,0), tilt: Math.PI/2, speed: 0.0004, count: polarSats.count })

  // 信关站与攻击终端（作为地球的子节点，随地球自转）
  gatewayGroup = new THREE.Group()
  terminalGroup = new THREE.Group()
  earthMesh.add(gatewayGroup)
  earthMesh.add(terminalGroup)
  // 取消继承地球的缩放：设置子组为地球缩放的倒数，保证世界尺度稳定
  {
    const s = Math.max(getEarthScale(), 1e-6)
    const inv = 1 / s
    gatewayGroup.scale.setScalar(inv)
    terminalGroup.scale.setScalar(inv)
  }

  addGateways()
  addTerminals()

  // 异步加载并替换 GLB 模型（earth、GEO 环、LEO 环）
  loadEarthModel()
  loadOrbitModels({ geoRadius, lowRadius })

  // 异步加载并克隆各轨道卫星 GLB，完成后隐藏占位小球
  for (const g of satGroups) {
    const path = SAT_MODEL_MAP[g.type]
    if (!path) continue
    loadSatModelsForGroup(g, path)
  }

  // 自适应
  window.addEventListener('resize', onResize)
}

function fitModelToRadius(model, targetRadius) {
  const box = new THREE.Box3().setFromObject(model)
  const size = new THREE.Vector3()
  box.getSize(size)
  const approxRadius = Math.max(size.x, size.y, size.z) / 2
  const scale = targetRadius / Math.max(approxRadius, 1e-6)
  model.scale.setScalar(scale)
}

function loadEarthModel() {
  gltfLoader.load('/earth.glb', (gltf) => {
    const model = gltf.scene || gltf.scenes?.[0]
    if (!model) return
    // 按 WORLD_R_SCALE 拟合地球半径
    fitModelToRadius(model, WORLD_R_SCALE)
    scene.add(model)
    if (earthMesh) {
      earthMesh.visible = false
      // 迁移信关站与终端到新的地球模型下，保持随自转
      if (gatewayGroup) {
        if (gatewayGroup.parent) gatewayGroup.parent.remove(gatewayGroup)
        model.add(gatewayGroup)
        // 设置为地球缩放的倒数，抵消父级缩放带来的体量放大
        const s = Math.max(model.scale.x, 1e-6)
        gatewayGroup.scale.setScalar(1 / s)
      }
      if (terminalGroup) {
        if (terminalGroup.parent) terminalGroup.parent.remove(terminalGroup)
        model.add(terminalGroup)
        // 设置为地球缩放的倒数，抵消父级缩放带来的体量放大
        const s = Math.max(model.scale.x, 1e-6)
        terminalGroup.scale.setScalar(1 / s)
      }
    }
    earthMesh = model
  }, undefined, (err) => {
    // 保持占位球体
    console.warn('Failed to load earth.glb', err)
  })
}

function loadOrbitModels({ geoRadius, lowRadius }) {
  // GEO 轨道环模型
  gltfLoader.load('/Geostationary_orbit.glb', (gltf) => {
    const model = gltf.scene || gltf.scenes?.[0]
    if (!model) return
    fitModelToRadius(model, geoRadius)
    // 围绕 X 轴倾角为 0，与赤道平面对齐
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), 0)
    model.setRotationFromQuaternion(q)
    orbitGroup.add(model)
    if (geoRingRef) geoRingRef.visible = false
  }, undefined, (err) => {
    console.warn('Failed to load Geostationary_orbit.glb', err)
  })

  // LEO 轨道环模型
  gltfLoader.load('/Low_Earth_Orbit.glb', (gltf) => {
    const model = gltf.scene || gltf.scenes?.[0]
    if (!model) return
    fitModelToRadius(model, lowRadius)
    // 围绕 X 轴倾角为 45°
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), Math.PI/4)
    model.setRotationFromQuaternion(q)
    orbitGroup.add(model)
    if (lowRingRef) lowRingRef.visible = false
  }, undefined, (err) => {
    console.warn('Failed to load Low_Earth_Orbit.glb', err)
  })
}

function fitModelToMaxSize(model, desiredMax = SAT_VISUAL_MAX) {
  const box = new THREE.Box3().setFromObject(model)
  const size = new THREE.Vector3(); box.getSize(size)
  const maxDim = Math.max(size.x, size.y, size.z)
  const scale = desiredMax / Math.max(maxDim, 1e-6)
  model.scale.setScalar(scale)
}

function loadSatModelsForGroup(g, modelPath) {
  gltfLoader.load(modelPath, (gltf) => {
    const tpl = gltf.scene || gltf.scenes?.[0]
    if (!tpl) return
    const models = []
    const count = g.count ?? g.mesh?.count ?? 0
    for (let i = 0; i < count; i++) {
      const m = tpl.clone(true)
      fitModelToMaxSize(m, SAT_VISUAL_MAX) // 统一视觉尺寸，可按需调整
      orbitGroup.add(m)
      models.push(m)
    }
    g.models = models
    // 隐藏占位 InstancedMesh
    if (g.mesh) g.mesh.visible = false
  }, undefined, (err) => {
    console.warn('Failed to load satellite glb', modelPath, err)
  })
}

function latLonToVec3(latDeg, lonDeg, radius = WORLD_R_SCALE) {
  const lat = THREE.MathUtils.degToRad(latDeg)
  const lon = THREE.MathUtils.degToRad(lonDeg)
  const x = radius * Math.cos(lat) * Math.cos(lon)
  const y = radius * Math.sin(lat)
  const z = radius * Math.cos(lat) * Math.sin(lon)
  return new THREE.Vector3(x, y, z)
}

function addGateways() {
  // 先创建占位模型，随后用 GLB 模型替换
  const dishGeo = new THREE.SphereGeometry(6, 16, 16, 0, Math.PI)
  const baseGeo = new THREE.CylinderGeometry(3, 3, 6, 16)
  const mat = new THREE.MeshStandardMaterial({ color: 0x88ffcc, emissive: 0x224433, emissiveIntensity: 0.2 })

  const locs = [
    { name: 'Beijing', lat: 39.9, lon: 116.4 },
    { name: 'London', lat: 51.5, lon: -0.1 },
    { name: 'NewYork', lat: 40.7, lon: -74.0 },
    { name: 'Sydney', lat: -33.9, lon: 151.2 }
  ]

  for (const l of locs) {
    const posWorld = latLonToVec3(l.lat, l.lon, WORLD_R_SCALE + SURFACE_OFFSET)
    const group = new THREE.Group()
    const base = new THREE.Mesh(baseGeo, mat)
    base.position.set(0, 3, 0)
    const dish = new THREE.Mesh(dishGeo, mat)
    dish.rotation.x = -Math.PI / 2
    dish.position.set(0, 6, 0)
    group.add(base)
    group.add(dish)
    // 直接使用世界坐标作为本地坐标，因父级缩放已被抵消
    group.position.copy(posWorld)
    // 沿球面法线对齐：将本地 Y 轴对齐到该点法线方向
    {
      const up = new THREE.Vector3(0,1,0)
      const normalWorld = posWorld.clone().normalize()
      const q = new THREE.Quaternion().setFromUnitVectors(up, normalWorld)
      group.quaternion.copy(q)
    }
    gatewayGroup.add(group)
    gateways.push({ name: l.name, pos: posWorld, obj: group, ip: GATEWAY_IP_MAP[l.name] || null })
  }

  // 异步替换为 Ground_zone.glb
  gltfLoader.load('/Ground_zone.glb', (gltf) => {
    const template = gltf.scene || gltf.scenes?.[0]
    if (!template) return
    for (const g of gateways) {
      const clone = template.clone(true)
      // 缩放到与占位体量相近（按包围盒高度粗略匹配）
      const box = new THREE.Box3().setFromObject(clone)
      const size = new THREE.Vector3(); box.getSize(size)
      const targetHeight = 8 // 降低整体高度以贴近地表
      const scale = targetHeight / Math.max(size.y, 1e-6)
      clone.scale.setScalar(scale)
      // 让模型底部落在本地 y=0（即球面），不依赖模型原点
      const bbox = new THREE.Box3().setFromObject(clone)
      const minY = bbox.min.y
      clone.position.y -= minY
      // 轻微抬升避免与球面共面闪烁
      clone.position.y += 0.1
      // 作为子节点插入到已对齐法线的 group 中
      g.obj.children.forEach(c => c.visible = false)
      g.obj.add(clone)
    }
  }, undefined, (err) => {
    console.warn('Failed to load Ground_zone.glb', err)
  })
}

function addTerminals(count = 40) {
  // 电脑终端的简易模型：小方块
  const geom = new THREE.BoxGeometry(4, 2.5, 2)
  const mat = new THREE.MeshStandardMaterial({ color: 0x99aaff, emissive: 0x111122, emissiveIntensity: 0.15 })

  for (let i = 0; i < count; i++) {
    // 随机分布在陆地区域的近似（简化为 |lat| < 60）
    const lat = (Math.random() * 120 - 60)
    const lon = (Math.random() * 360 - 180)
    // 为每个终端生成一个稳定的私有网段 IP
    const ip = `10.${i % 256}.${(i * 7) % 256}.${(i * 13) % 256}`
    const posWorld = latLonToVec3(lat, lon, WORLD_R_SCALE + SURFACE_OFFSET)
    const m = new THREE.Mesh(geom, mat)
    // 终端中心位于球面会半嵌入，这里按高度的一半沿法线外推，使底部贴地
    const up = new THREE.Vector3(0,1,0)
    const normalWorld = posWorld.clone().normalize()
    const halfHeight = (geom.parameters?.height ?? 2.5) * 0.5
    const posLifted = posWorld.clone().add(normalWorld.clone().multiplyScalar(halfHeight))
    // 直接使用世界坐标作为本地坐标，因父级缩放已被抵消
    m.position.copy(posLifted)
    // 沿球面法线对齐：将本地 Y 轴对齐到该点法线方向
    {
      const q = new THREE.Quaternion().setFromUnitVectors(up, normalWorld)
      m.quaternion.copy(q)
    }
    terminalGroup.add(m)
    terminals.push({ lat, lon, pos: posWorld, obj: m, ip })
  }
}

function pickRandomTerminal() {
  if (terminals.length === 0) return null
  return terminals[Math.floor(Math.random() * terminals.length)]
}

function getNearestGateway(pos) {
  let best = null
  let bestDist = Infinity
  for (const g of gateways) {
    const d = g.pos.distanceTo(pos)
    if (d < bestDist) { bestDist = d; best = g }
  }
  return best
}

function makeArcCurve(a, b, elevated = false) {
  const mid = a.clone().add(b).multiplyScalar(0.5)
  const height = elevated ? WORLD_R_SCALE * 1.5 : WORLD_R_SCALE * 1.1
  const ctrl = mid.clone().normalize().multiplyScalar(height)
  return new THREE.QuadraticBezierCurve3(a, ctrl, b)
}

function addParticleFlowLine(curve, color = 0xff0000, widthPx = 2, duration = 3, speed = 0.3, onArrive, getEndLatest = null, emissionRateParam = 8) {
  // 公开的飞线生命周期引用（供其他动效判断何时结束）
  const lineRef = { done: false, alive: 0 }
  // 透明底线（低透明度）
  let baseGeo, baseMat, baseMesh
  if (!getEndLatest) {
    baseGeo = new THREE.TubeGeometry(curve, 256, widthPx * 0.2, 8, false)
    baseMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15 })
    baseMesh = new THREE.Mesh(baseGeo, baseMat)
    baseMesh.renderOrder = 4
    scene.add(baseMesh)
  }

  // 粒子沿路径运动（少量、持续发射的“炮弹”）
  const maxParticles = 100
  const positions = new Float32Array(maxParticles * 3)
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setDrawRange(0, 0) // 初始不绘制任何粒子
  const px = Math.min(window.devicePixelRatio || 1, 2)
  const mat = new THREE.PointsMaterial({ color, size: 6 * px, transparent: true, opacity: 1, sizeAttenuation: false })
  mat.blending = THREE.AdditiveBlending
  mat.depthWrite = false
  const points = new THREE.Points(geom, mat)
  points.renderOrder = 6
  scene.add(points)

  // 发射队列：按速率逐个生成，数量不多
  const ts = new Float32Array(maxParticles)
  for (let i = 0; i < maxParticles; i++) ts[i] = -1 // -1 表示未激活（死亡）

  const startSec = performance.now() * 0.001
  let alive = 0
  let emitAcc = 0
  const emissionRate = emissionRateParam // 每秒发射粒子数（可调）
  let arrivedOnce = false
  const effect = {
    update(delta, nowSec) {
      // 若提供动态终点，则每帧更新曲线的终点与控制点，使终点跟随当前卫星位置
      if (getEndLatest) {
        const end = getEndLatest()
        const a = curve.v0
        const mid = a.clone().add(end).multiplyScalar(0.5)
        const height = WORLD_R_SCALE * 1.5 // 使用抬升弧线的高度
        const ctrl = mid.clone().normalize().multiplyScalar(height)
        curve.v1.copy(ctrl)
        curve.v2.copy(end)
      }
      const t = nowSec - startSec
      if (t > duration) {
        scene.remove(points); geom.dispose(); mat.dispose()
        if (baseMesh) { scene.remove(baseMesh); baseGeo.dispose(); baseMat.dispose() }
        lineRef.done = true
        return false
      }
      // 发射新粒子（持续发射炮弹）
      emitAcc += emissionRate * delta
      while (emitAcc >= 1) {
        emitAcc -= 1
        if (alive < maxParticles) {
          ts[alive] = 0
          alive++
        } else {
          // 复用已到达终点的粒子
          let reused = false
          for (let i = 0; i < alive; i++) {
            if (ts[i] >= 1) { ts[i] = 0; reused = true; break }
          }
          if (!reused) break
        }
      }

      // 推进与压缩存活粒子
      let write = 0
      for (let i = 0; i < alive; i++) {
        let tp = ts[i]
        if (tp < 0) continue // 未激活
        tp += speed * delta
        if (tp >= 1) {
          ts[i] = -1
          if (!arrivedOnce && onArrive) {
            arrivedOnce = true
            const endPos = curve.getPoint(1)
            try { onArrive(endPos) } catch (err) { /* 安全处理到达回调异常 */ }
          }
          continue
        } // 到终点后移出
        ts[i] = tp
        const p = curve.getPoint(tp)
        positions[write*3] = p.x
        positions[write*3+1] = p.y
        positions[write*3+2] = p.z
        write++
      }
      alive = write
      lineRef.alive = alive
      geom.setDrawRange(0, alive)
      geom.attributes.position.needsUpdate = true
      geom.computeBoundingSphere()

      // 兜底：若出现粒子复用导致未触发抵达事件，按预计到达时间触发一次
      if (!arrivedOnce && onArrive) {
        const elapsed = nowSec - startSec
        const eta = 1 / Math.max(0.001, speed) // 以参数推进估算到达时间
        let nearEnd = false
        for (let i = 0; i < alive; i++) { if (ts[i] >= 0.98) { nearEnd = true; break } }
        if (nearEnd || elapsed >= eta * 1.2) {
          arrivedOnce = true
          const endPos = curve.getPoint(1)
          try { onArrive(endPos) } catch (err) { /* 安全处理到达回调异常 */ }
        }
      }
    }
  }
  effects.push(effect)
  return lineRef
}

function linkTerminalToGateway(terminal, color, widthPx, onArrive, opts = {}) {
  const gw = getNearestGateway(terminal.pos)
  if (!gw) return
  const sameHemisphere = Math.sign(terminal.lat) === Math.sign(gw.pos.y)
  const curve1 = makeArcCurve(terminal.pos, gw.pos, !sameHemisphere)
  // 第一段仅展示飞线，不在网关处触发动效
  const speed = opts.speed ?? 0.4
  const duration = opts.duration ?? 10
  const emissionRate = opts.emissionRate ?? 8
  addParticleFlowLine(curve1, color, widthPx, duration, speed, null, null, emissionRate)

  // 选择一个卫星实例，并计算其“当前”世界坐标作为第二段目的地
  const orbit = satGroups[Math.floor(Math.random() * satGroups.length)]
  const count = orbit.count ?? orbit.mesh?.count ?? 1
  const idx = Math.floor(Math.random() * count)
  const getSatPos = () => {
    const simNowSec = performance.now() * 0.001 * SIM_SPEED
    let target
    if (orbit.a && orbit.b) {
      if (!orbit.arcTable) orbit.arcTable = buildEllipseArcTable(orbit.a, orbit.b)
      const total = orbit.arcTable.total
      const cyclesPerSec = orbit.speed / (2 * Math.PI)
      const sNow = (idx / count) * total + simNowSec * cyclesPerSec * total
      const tParam = findTForArcLength(orbit.arcTable, sNow)
      target = new THREE.Vector3(Math.cos(tParam) * orbit.a, 0, Math.sin(tParam) * orbit.b)
    } else {
      const tNow = (idx / count) * Math.PI * 2 + simNowSec * orbit.speed
      target = new THREE.Vector3(Math.cos(tNow) * orbit.radius, 0, Math.sin(tNow) * orbit.radius)
    }
    const q = new THREE.Quaternion().setFromAxisAngle(orbit.tiltAxis.clone().normalize(), orbit.tilt)
    target.applyQuaternion(q)
    return target
  }
  const initialTarget = getSatPos()
  const curve2 = makeArcCurve(gw.pos, initialTarget, true)
  // 仅在第二段（最终目的地：卫星点）触发动效
  let lineRef2
  const onArriveFollow = () => {
    try { onArrive(getSatPos, lineRef2) } catch (_) {}
  }
  const width2 = opts.width2 ?? 1.5
  lineRef2 = addParticleFlowLine(curve2, color, width2, duration, speed, onArriveFollow, getSatPos, emissionRate)
}

// 2.1 异常流量检测（闪烁动效）
function startAbnormalTraffic(terminal) {
  const m = terminal.obj.material
  const start = performance.now() * 0.001
  const duration = 5
  const effect = {
    update(delta, now) {
      const t = now - start
      if (t > duration) { m.emissiveIntensity = 0.15; return false }
      const freq = t < 2 ? 1 + (t / 2) * (3 - 1) : 3
      const brightness = (Math.sin(now * freq * 2 * Math.PI) * 0.5 + 0.5)
      const mapped = 0.5 + brightness * (2.0 - 0.5) // 0.5～2.0
      m.emissiveIntensity = mapped
    }
  }
  effects.push(effect)
}

// 2.2 节点攻陷（爆炸效果）
function startCompromiseExplosion(terminal) {
  const n = 200
  const positions = new Float32Array(n * 3)
  const velocities = new Float32Array(n * 3)
  const accel = -9.8
  const normal = terminal.pos.clone().normalize()
  const colors = new Float32Array(n * 3)
  const color = new THREE.Color('#e74c3c')
  for (let i = 0; i < n; i++) {
    positions[i*3] = terminal.pos.x
    positions[i*3+1] = terminal.pos.y
    positions[i*3+2] = terminal.pos.z
    const dir = new THREE.Vector3(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1).normalize()
    const speed = 5 + Math.random()*10
    velocities[i*3] = dir.x * speed
    velocities[i*3+1] = dir.y * speed
    velocities[i*3+2] = dir.z * speed
    colors[i*3] = color.r; colors[i*3+1] = color.g; colors[i*3+2] = color.b
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({ size: 4, vertexColors: true, transparent: true, opacity: 1 })
  const points = new THREE.Points(geom, mat)
  scene.add(points)
  const start = performance.now() * 0.001
  const duration = 2
  const effect = {
    update(delta, now) {
      const t = now - start
      if (t > duration) { scene.remove(points); geom.dispose(); mat.dispose(); return false }
      for (let i = 0; i < n; i++) {
        velocities[i*3] += normal.x * accel * delta
        velocities[i*3+1] += normal.y * accel * delta
        velocities[i*3+2] += normal.z * accel * delta
        positions[i*3] += velocities[i*3] * delta
        positions[i*3+1] += velocities[i*3+1] * delta
        positions[i*3+2] += velocities[i*3+2] * delta
      }
      geom.attributes.position.needsUpdate = true
      mat.opacity = Math.max(0, 1 - t / duration)
    }
  }
  effects.push(effect)
}

// 2.3 防御系统激活（防护罩动画）
function startDefenseShield(terminal) {
  const shieldGeo = new THREE.SphereGeometry(15, 32, 32)
  const shieldMat = new THREE.MeshStandardMaterial({ color: 0x2ecc71, transparent: true, opacity: 0.5, emissive: 0x2ecc71, emissiveIntensity: 0.2 })
  const shield = new THREE.Mesh(shieldGeo, shieldMat)
  shield.position.copy(terminal.pos)
  scene.add(shield)
  const start = performance.now() * 0.001
  const duration = 5
  const effect = {
    update(delta, now) {
      const t = now - start
      if (t > duration) { scene.remove(shield); shieldGeo.dispose(); shieldMat.dispose(); return false }
      shield.rotation.y += 0.5 * delta
      shieldMat.opacity = 0.3 + 0.5 * (Math.sin(now * 2) * 0.5 + 0.5)
    }
  }
  effects.push(effect)
}

// 2.4 DDoS 攻击（脉冲扩散）
function startDDOSPulses(terminal) {
  const pulses = []
  for (let i = 0; i < 3; i++) {
    const geo = new THREE.RingGeometry(10, 10.5, 64)
    const mat = new THREE.MeshBasicMaterial({ color: 0xe74c3c, transparent: true, opacity: 1, side: THREE.DoubleSide })
    const ring = new THREE.Mesh(geo, mat)
    ring.position.copy(terminal.pos)
    ring.lookAt(terminal.pos.clone().multiplyScalar(2))
    scene.add(ring)
    pulses.push({ obj: ring, geo, mat, startDelay: i * 0.3 })
  }
  const start = performance.now() * 0.001
  const effect = {
    update(delta, now) {
      const t = now - start
      let allDone = true
      for (const p of pulses) {
        const tp = t - p.startDelay
        if (tp < 0) { allDone = false; continue }
        if (tp > 1.5) { continue }
        allDone = false
        const s = 1 + (tp / 1.5) * (50/10 - 1)
        p.obj.scale.setScalar(s)
        p.mat.opacity = Math.max(0, 1 - tp / 1.5)
      }
      if (allDone) {
        for (const p of pulses) { scene.remove(p.obj); p.geo.dispose(); p.mat.dispose() }
        return false
      }
    }
  }
  effects.push(effect)
}

// 2.5 信息窃取（数据泄露）
function startExfiltration(terminal) {
  const n = 100
  const positions = new Float32Array(n * 3)
  const velocities = new Float32Array(n * 3)
  const color = new THREE.Color('#f39c12')
  const colors = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    positions[i*3] = terminal.pos.x
    positions[i*3+1] = terminal.pos.y
    positions[i*3+2] = terminal.pos.z
    const dir = terminal.pos.clone().normalize().multiplyScalar(1)
    const speed = 10 + Math.random()*20
    velocities[i*3] = dir.x * speed
    velocities[i*3+1] = dir.y * speed
    velocities[i*3+2] = dir.z * speed
    colors[i*3] = color.r; colors[i*3+1] = color.g; colors[i*3+2] = color.b
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({ size: 3, vertexColors: true, transparent: true, opacity: 1 })
  const points = new THREE.Points(geom, mat)
  scene.add(points)
  const start = performance.now() * 0.001
  const duration = 3
  const trailFactor = 0.92
  const effect = {
    update(delta, now) {
      const t = now - start
      if (t > duration) { scene.remove(points); geom.dispose(); mat.dispose(); return false }
      for (let i = 0; i < n; i++) {
        positions[i*3] = positions[i*3] * trailFactor + (positions[i*3] + velocities[i*3]*delta) * (1 - trailFactor)
        positions[i*3+1] = positions[i*3+1] * trailFactor + (positions[i*3+1] + velocities[i*3+1]*delta) * (1 - trailFactor)
        positions[i*3+2] = positions[i*3+2] * trailFactor + (positions[i*3+2] + velocities[i*3+2]*delta) * (1 - trailFactor)
      }
      geom.attributes.position.needsUpdate = true
    }
  }
  effects.push(effect)
}

// 2.6 漏洞修复（系统修复）
function startPatchSequence(terminal) {
  const obj = terminal.obj
  const originalPos = obj.position.clone()
  const fragCnt = 8
  const frags = []
  const group = new THREE.Group()
  obj.visible = false
  group.position.copy(originalPos)
  const mat = new THREE.MeshStandardMaterial({ color: 0x99aaff, emissive: 0x111122, emissiveIntensity: 0.15 })
  for (let i = 0; i < fragCnt; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(2,1.2,1), mat)
    m.position.set((Math.random()*2-1), (Math.random()*2-1), (Math.random()*2-1))
    group.add(m)
    frags.push(m)
  }
  scene.add(group)
  const start = performance.now() * 0.001
  const g = 4.9
  const shieldGeo = new THREE.SphereGeometry(15, 32, 32)
  const shieldMat = new THREE.MeshStandardMaterial({ color: 0x9b59b6, transparent: true, opacity: 0.6, emissive: 0x9b59b6, emissiveIntensity: 0.2 })
  const shield = new THREE.Mesh(shieldGeo, shieldMat)
  shield.position.copy(originalPos)
  let phase = 'break'
  const effect = {
    update(delta, now) {
      const t = now - start
      if (phase === 'break') {
        for (const m of frags) {
          const dir = m.position.clone().normalize()
          m.position.addScaledVector(dir, 5 * delta)
        }
        if (t > 0.6) { phase = 'assemble' }
      } else if (phase === 'assemble') {
        for (const m of frags) {
          const dir = m.position.clone().multiplyScalar(-1).normalize()
          m.position.addScaledVector(dir, g * delta)
        }
        if (t > 1.8) {
          phase = 'reinforce'
          scene.add(shield)
        }
      } else if (phase === 'reinforce') {
        shield.rotation.y += 0.5 * delta
        shieldMat.opacity = 0.4 + 0.4 * (Math.sin(now * 2) * 0.5 + 0.5)
        if (t > 3.8) {
          scene.remove(group)
          scene.remove(shield)
          shieldGeo.dispose(); shieldMat.dispose()
          obj.visible = true
          // 节点颜色变为 #9b59b6（强化）
          obj.material.color = new THREE.Color('#9b59b6')
          return false
        }
      }
    }
  }
  effects.push(effect)
}

function onResize() {
  if (!renderer || !camera || !containerRef.value) return
  const w = containerRef.value.clientWidth
  const h = containerRef.value.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

function animate() {
  // 地球自转：约 0.2 弧度/秒（可调）
  const delta = clock.getDelta()
  earthMesh.rotation.y += 0.2 * delta

  // 更新信关站与终端的世界坐标，确保后续计算最近网关/飞线起终点正确
  for (const g of gateways) {
    if (g?.obj) g.obj.getWorldPosition(g.pos)
  }
  for (const t of terminals) {
    if (t?.obj) t.obj.getWorldPosition(t.pos)
  }

  // 卫星沿轨道运动（简单角速度模型）
  for (const g of satGroups) {
    const mesh = g.mesh
    const models = g.models
    const count = g.count ?? mesh?.count ?? 0
    const rotAxis = g.tiltAxis.clone().normalize()
    const q = new THREE.Quaternion().setFromAxisAngle(rotAxis, g.tilt)
    const temp = new THREE.Object3D()
    const simNowSec = performance.now() * 0.001 * SIM_SPEED
    if (g.a && g.b) {
      // 椭圆轨道：按等弧长保持均匀间距，匀速沿轨道移动
      if (!g.arcTable) g.arcTable = buildEllipseArcTable(g.a, g.b)
      const total = g.arcTable.total
      const cyclesPerSec = g.speed / (2 * Math.PI)
      const phaseS = simNowSec * cyclesPerSec * total
      for (let i = 0; i < count; i++) {
        const s = (i / count) * total + phaseS
        const tParam = findTForArcLength(g.arcTable, s)
        const p = new THREE.Vector3(Math.cos(tParam) * g.a, 0, Math.sin(tParam) * g.b)
        p.applyQuaternion(q)
        if (models && models[i]) {
          models[i].position.copy(p)
          models[i].lookAt(p.clone().multiplyScalar(2))
        } else if (mesh) {
          temp.position.copy(p)
          temp.updateMatrix()
          mesh.setMatrixAt(i, temp.matrix)
        }
      }
    } else {
      // 圆形轨道：直接按角速度移动，保持均匀间距
      const baseAngle = simNowSec * g.speed
      for (let i = 0; i < count; i++) {
        const t = (i / count) * Math.PI * 2 + baseAngle
        const p = new THREE.Vector3(Math.cos(t) * g.radius, 0, Math.sin(t) * g.radius)
        p.applyQuaternion(q)
        if (models && models[i]) {
          models[i].position.copy(p)
          models[i].lookAt(p.clone().multiplyScalar(2))
        } else if (mesh) {
          temp.position.copy(p)
          temp.updateMatrix()
          mesh.setMatrixAt(i, temp.matrix)
        }
      }
    }
    if (mesh) mesh.instanceMatrix.needsUpdate = true
  }

  // 更新特效与飞线生命周期（使用同一帧的 delta）
  const nowSec = performance.now() * 0.001
  // 安全更新特效：避免单个动效异常导致整帧停止
  {
    const next = []
    for (const e of effects) {
      try {
        const alive = e.update?.(delta, nowSec) !== false
        if (alive) next.push(e)
      } catch (err) {
        // 忽略异常，继续其他动效
      }
    }
    effects = next
  }
  flyLines = flyLines.filter(l => {
    if (nowSec - l.startTime > l.duration) {
      scene.remove(l.obj)
      l.obj.geometry?.dispose?.()
      l.obj.material?.dispose?.()
      return false
    }
    return true
  })

  // 特效与飞线生命周期在上面已更新
  controls.update() // 阻尼动画
  renderer.render(scene, camera)
  animationId = requestAnimationFrame(animate)
}

const clock = new THREE.Clock()

onMounted(() => {
  init()
  animate()

  // 监听控制面板事件（后续将实现具体动效）
  bus.on('attack:trigger', ({ type, mode }) => {
    const terminal = pickRandomTerminal()
    if (!terminal) return
    const berserk = mode === 'berserk'
    const opts = berserk ? { speed: 0.75, duration: 12, emissionRate: 14, width2: 2.5 } : { speed: 0.4, duration: 10, emissionRate: 8, width2: 1.5 }
    const widthPx = berserk ? 3 : 2
    // 计算最近网关并向信息列表推送事件
    const gw = getNearestGateway(terminal.pos)
  bus.emit('attack:started', {
    id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    ts: Date.now(),
    type,
    mode,
    terminal: { ip: gw?.ip || '-' },
    gateway: { name: gw?.name ?? 'Unknown', ip: gw?.ip || '-' }
  })
    switch (type) {
      case 'abnormal':
        linkTerminalToGateway(terminal, 0xff0000, widthPx, (getPos, lifeRef) => startAbnormalTrafficAt(getPos, lifeRef, 0xff0000), opts)
        break
      case 'compromise':
        linkTerminalToGateway(terminal, 0xe74c3c, widthPx, (getPos, lifeRef) => startCompromiseExplosionAt(getPos, lifeRef), opts)
        break
      case 'defense':
        linkTerminalToGateway(terminal, 0x2ecc71, widthPx, (getPos, lifeRef) => startDefenseShieldAt(getPos, lifeRef), opts)
        break
      case 'ddos':
        linkTerminalToGateway(terminal, 0xe74c3c, widthPx, (getPos, lifeRef) => startDDOSPulsesAt(getPos, lifeRef), opts)
        break
      case 'exfiltration':
        linkTerminalToGateway(terminal, 0xf39c12, widthPx, (getPos, lifeRef) => startExfiltrationAt(getPos, lifeRef), opts)
        break
      case 'patch':
        // 终点位置播放修复光晕，不再在起点做碎片化修复
        linkTerminalToGateway(terminal, 0x9b59b6, widthPx, (getPos, lifeRef) => startPatchHaloAt(getPos, lifeRef), opts)
        break
    }
  })
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('resize', onResize)
  controls?.dispose()
  renderer?.dispose()
})

// 2.1a 异常流量（终点位置的脉动光晕）
function startAbnormalTrafficAt(posOrGetter, lifeRef, color = 0xff0000) {
  const getPos = typeof posOrGetter === 'function' ? posOrGetter : () => posOrGetter
  const sGeo = new THREE.SphereGeometry(8, 16, 16)
  const sMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, transparent: true, opacity: 0.7 })
  const sMesh = new THREE.Mesh(sGeo, sMat)
  sMesh.position.copy(getPos())
  scene.add(sMesh)
  const start = performance.now() * 0.001
  const duration = 4
  const effect = {
    update(delta, now) {
      const t = now - start
      if (lifeRef?.done) { scene.remove(sMesh); sGeo.dispose(); sMat.dispose(); return false }
      const p = getPos()
      sMesh.position.copy(p)
      sMat.emissiveIntensity = 0.5 + 0.5 * (Math.sin(now * 6) * 0.5 + 0.5)
      sMat.opacity = 0.5 + 0.5 * (Math.sin(now * 4) * 0.5 + 0.5)
      sMesh.scale.setScalar(1 + 0.1 * Math.sin(now * 3))
    }
  }
  effects.push(effect)
}

// 2.2a 节点攻陷（终点位置爆炸）
function startCompromiseExplosionAt(posOrGetter, lifeRef) {
  const getPos = typeof posOrGetter === 'function' ? posOrGetter : () => posOrGetter
  const n = 200
  const positions = new Float32Array(n * 3)
  const velocities = new Float32Array(n * 3)
  const accel = -9.8
  let prevCenter = getPos()
  let normal = prevCenter.clone().normalize()
  const colors = new Float32Array(n * 3)
  const color = new THREE.Color('#e74c3c')
  for (let i = 0; i < n; i++) {
    positions[i*3] = prevCenter.x
    positions[i*3+1] = prevCenter.y
    positions[i*3+2] = prevCenter.z
    const dir = new THREE.Vector3(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1).normalize()
    const speed = 5 + Math.random()*10
    velocities[i*3] = dir.x * speed
    velocities[i*3+1] = dir.y * speed
    velocities[i*3+2] = dir.z * speed
    colors[i*3] = color.r; colors[i*3+1] = color.g; colors[i*3+2] = color.b
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({ size: 4, vertexColors: true, transparent: true, opacity: 1 })
  const points = new THREE.Points(geom, mat)
  scene.add(points)
  const start = performance.now() * 0.001
  const duration = 2
  const effect = {
    update(delta, now) {
      const t = now - start
      if (lifeRef?.done) { scene.remove(points); geom.dispose(); mat.dispose(); return false }
      const center = getPos()
      const dx = center.x - prevCenter.x
      const dy = center.y - prevCenter.y
      const dz = center.z - prevCenter.z
      prevCenter = center
      normal = center.clone().normalize()
      for (let i = 0; i < n; i++) {
        positions[i*3] += dx
        positions[i*3+1] += dy
        positions[i*3+2] += dz
        velocities[i*3] += normal.x * accel * delta
        velocities[i*3+1] += normal.y * accel * delta
        velocities[i*3+2] += normal.z * accel * delta
        positions[i*3] += velocities[i*3] * delta
        positions[i*3+1] += velocities[i*3+1] * delta
        positions[i*3+2] += velocities[i*3+2] * delta
      }
      geom.attributes.position.needsUpdate = true
      mat.opacity = Math.max(0.15, 1 - t / duration)
    }
  }
  effects.push(effect)
}

// 2.3a 防御系统激活（终点位置的防护罩）
function startDefenseShieldAt(posOrGetter, lifeRef) {
  const getPos = typeof posOrGetter === 'function' ? posOrGetter : () => posOrGetter
  const shieldGeo = new THREE.SphereGeometry(15, 32, 32)
  const shieldMat = new THREE.MeshStandardMaterial({ color: 0x2ecc71, transparent: true, opacity: 0.5, emissive: 0x2ecc71, emissiveIntensity: 0.2 })
  const shield = new THREE.Mesh(shieldGeo, shieldMat)
  shield.position.copy(getPos())
  scene.add(shield)
  const start = performance.now() * 0.001
  const duration = 5
  const effect = {
    update(delta, now) {
      const t = now - start
      if (lifeRef?.done) { scene.remove(shield); shieldGeo.dispose(); shieldMat.dispose(); return false }
      const p = getPos()
      shield.position.copy(p)
      shield.rotation.y += 0.5 * delta
      shieldMat.opacity = 0.3 + 0.5 * (Math.sin(now * 2) * 0.5 + 0.5)
    }
  }
  effects.push(effect)
}

// 2.4a DDoS 脉冲（终点位置）
function startDDOSPulsesAt(posOrGetter, lifeRef) {
  const getPos = typeof posOrGetter === 'function' ? posOrGetter : () => posOrGetter
  const pulses = []
  for (let i = 0; i < 3; i++) {
    const geo = new THREE.RingGeometry(10, 10.5, 64)
    const mat = new THREE.MeshBasicMaterial({ color: 0xe74c3c, transparent: true, opacity: 1, side: THREE.DoubleSide })
    const ring = new THREE.Mesh(geo, mat)
    const p0 = getPos()
    ring.position.copy(p0)
    ring.lookAt(p0.clone().multiplyScalar(2))
    scene.add(ring)
    pulses.push({ obj: ring, geo, mat, startDelay: i * 0.3 })
  }
  const start = performance.now() * 0.001
  const effect = {
    update(delta, now) {
      const t = now - start
      let allDone = true
      for (const p of pulses) {
        const tp = t - p.startDelay
        if (tp < 0) { allDone = false; continue }
        if (tp > 1.5) { continue }
        allDone = false
        const c = getPos()
        p.obj.position.copy(c)
        p.obj.lookAt(c.clone().multiplyScalar(2))
        const s = 1 + (tp / 1.5) * (50/10 - 1)
        p.obj.scale.setScalar(s)
        p.mat.opacity = Math.max(0, 1 - tp / 1.5)
      }
      if (lifeRef?.done || allDone) {
        for (const p of pulses) { scene.remove(p.obj); p.geo.dispose(); p.mat.dispose() }
        return false
      }
    }
  }
  effects.push(effect)
}

// 2.5a 信息窃取（终点位置）
function startExfiltrationAt(posOrGetter, lifeRef) {
  const getPos = typeof posOrGetter === 'function' ? posOrGetter : () => posOrGetter
  const n = 100
  const positions = new Float32Array(n * 3)
  const velocities = new Float32Array(n * 3)
  const color = new THREE.Color('#f39c12')
  const colors = new Float32Array(n * 3)
  let prevCenter = getPos()
  for (let i = 0; i < n; i++) {
    positions[i*3] = prevCenter.x
    positions[i*3+1] = prevCenter.y
    positions[i*3+2] = prevCenter.z
    const dir = prevCenter.clone().normalize().multiplyScalar(1)
    const speed = 10 + Math.random()*20
    velocities[i*3] = dir.x * speed
    velocities[i*3+1] = dir.y * speed
    velocities[i*3+2] = dir.z * speed
    colors[i*3] = color.r; colors[i*3+1] = color.g; colors[i*3+2] = color.b
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({ size: 3, vertexColors: true, transparent: true, opacity: 1 })
  const points = new THREE.Points(geom, mat)
  scene.add(points)
  const start = performance.now() * 0.001
  const duration = 3
  const trailFactor = 0.92
  const effect = {
    update(delta, now) {
      const t = now - start
      if (lifeRef?.done) { scene.remove(points); geom.dispose(); mat.dispose(); return false }
      const center = getPos()
      const dx = center.x - prevCenter.x
      const dy = center.y - prevCenter.y
      const dz = center.z - prevCenter.z
      prevCenter = center
      for (let i = 0; i < n; i++) {
        positions[i*3] += dx
        positions[i*3+1] += dy
        positions[i*3+2] += dz
        positions[i*3] = positions[i*3] * trailFactor + (positions[i*3] + velocities[i*3]*delta) * (1 - trailFactor)
        positions[i*3+1] = positions[i*3+1] * trailFactor + (positions[i*3+1] + velocities[i*3+1]*delta) * (1 - trailFactor)
        positions[i*3+2] = positions[i*3+2] * trailFactor + (positions[i*3+2] + velocities[i*3+2]*delta) * (1 - trailFactor)
      }
      geom.attributes.position.needsUpdate = true
    }
  }
  effects.push(effect)
}

// 2.6a 漏洞修复（终点位置的紫色光晕）
function startPatchHaloAt(posOrGetter, lifeRef) {
  const getPos = typeof posOrGetter === 'function' ? posOrGetter : () => posOrGetter
  const geo = new THREE.SphereGeometry(10, 24, 24)
  const mat = new THREE.MeshStandardMaterial({ color: 0x9b59b6, emissive: 0x9b59b6, emissiveIntensity: 0.4, transparent: true, opacity: 0.6 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.copy(getPos())
  scene.add(mesh)
  const start = performance.now() * 0.001
  const duration = 4
  const effect = {
    update(delta, now) {
      const t = now - start
      if (lifeRef?.done) { scene.remove(mesh); geo.dispose(); mat.dispose(); return false }
      const p = getPos()
      mesh.position.copy(p)
      mat.opacity = 0.4 + 0.4 * (Math.sin(now * 3) * 0.5 + 0.5)
      mesh.scale.setScalar(1 + 0.15 * Math.sin(now * 2))
    }
  }
  effects.push(effect)
}
</script>

<template>
  <div ref="containerRef" class="three-container" />
</template>

<style scoped>
.three-container {
  position: absolute;
  inset: 0;
  background: #000000;
}
</style>