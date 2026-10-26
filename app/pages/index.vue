<script setup lang="ts">
import { computed, ref } from 'vue'

type RouteMode = 'draw' | 'select'
type SurfaceGroup = 'paved' | 'gravel' | 'sidewalk' | 'unknown'
type Position = [number, number]
interface RouteSection { key: string, name: string, group: SurfaceGroup, parts: Position[][] }

const mode = ref<RouteMode>('draw')
const drawCoords = ref<Position[]>([])
const selectedSections = ref<RouteSection[]>([])
const message = ref('Loading Chaska trail layers…')
const saveKey = 'chaska-adventure-route-v1'

const sectionMeters = (section: RouteSection) => section.parts.reduce((sum, part) => sum + lengthMeters(part), 0)
const lengthMeters = (coords: Position[]) => {
  const radians = (degrees: number) => degrees * Math.PI / 180
  let meters = 0
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1]!
    const [lon2, lat2] = coords[i]!
    const dLat = radians(lat2 - lat1)
    const dLon = radians(lon2 - lon1)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2
    meters += 6_371_008.8 * 2 * Math.asin(Math.sqrt(a))
  }
  return meters
}

const routeSections = computed<RouteSection[]>(() => [
  ...selectedSections.value,
  ...(drawCoords.value.length ? [{ key: 'drawn', name: 'Drawn section', group: 'unknown' as const, parts: [drawCoords.value] }] : []),
])
const totalMeters = computed(() => routeSections.value.reduce((sum, section) => sum + sectionMeters(section), 0))
const knownMeters = computed(() => routeSections.value.filter(section => section.group !== 'unknown').reduce((sum, section) => sum + sectionMeters(section), 0))
const knownPercent = computed(() => totalMeters.value ? `${Math.round(knownMeters.value / totalMeters.value * 100)}%` : '—')
const surfaceSummary = computed(() => {
  const totals: Record<SurfaceGroup, number> = { paved: 0, gravel: 0, sidewalk: 0, unknown: 0 }
  for (const section of routeSections.value) totals[section.group] += sectionMeters(section)
  const miles = (meters: number) => `${(meters / 1609.344).toFixed(1)} mi`
  return `${miles(totals.paved)} paved · ${miles(totals.gravel)} gravel · ${miles(totals.sidewalk)} connector · ${miles(totals.unknown)} unknown`
})
const hasRoute = computed(() => routeSections.value.length > 0)

function updateRoute(payload: { drawCoords: Position[], selected: RouteSection[] }) {
  drawCoords.value = payload.drawCoords
  selectedSections.value = payload.selected
}

function saveRoute() {
  localStorage.setItem(saveKey, JSON.stringify({ savedAt: new Date().toISOString(), drawCoords: drawCoords.value, selected: selectedSections.value }))
  message.value = 'Route saved in this browser on this device.'
}

function restoreRoute() {
  try {
    const saved = JSON.parse(localStorage.getItem(saveKey) || 'null')
    if (!saved) {
      message.value = 'No saved route found in this browser yet.'
      return
    }
    updateRoute({ drawCoords: saved.drawCoords || [], selected: saved.selected || [] })
    message.value = `Restored route saved ${new Date(saved.savedAt).toLocaleString()}.`
  }
  catch {
    message.value = 'Could not read the saved route.'
  }
}

function clearRoute() {
  drawCoords.value = []
  selectedSections.value = []
}

function undoLast() {
  if (drawCoords.value.length) drawCoords.value = drawCoords.value.slice(0, -1)
  else selectedSections.value = selectedSections.value.slice(0, -1)
}
</script>

<template>
  <main class="app-shell">
    <aside class="side-panel">
      <div class="brand">Your Chaska field test</div>
      <h1>Build your own way.</h1>
      <p class="intro">Explore local roads and trails, then shape a run or walk that feels right to you.</p>

      <section class="card">
        <h2 class="card-title">Add to your route</h2>
        <div class="mode-row">
          <button class="mode-button" :class="{ active: mode === 'draw' }" @click="mode = 'draw'">✎ &nbsp;Draw route</button>
          <button class="mode-button" :class="{ active: mode === 'select' }" @click="mode = 'select'">⌁ &nbsp;Select trails</button>
        </div>
        <p class="hint">
          {{ mode === 'draw'
            ? 'Tap the map to add route points. Your line follows your clicks; it is not snapped to paths yet.'
            : 'Tap colored city trail segments to add or remove them from your route. Tap a segment again to remove it.' }}
        </p>
      </section>

      <section class="card">
        <h2 class="card-title">Your route</h2>
        <div class="stats-grid">
          <div>
            <div class="stat-label">Distance</div>
            <div class="stat-value">{{ (totalMeters / 1609.344).toFixed(2) }} mi</div>
            <div class="stat-sub">estimated from map geometry</div>
          </div>
          <div>
            <div class="stat-label">Known surface</div>
            <div class="stat-value">{{ knownPercent }}</div>
            <div class="stat-sub">of route with mapped surface</div>
          </div>
        </div>
        <p class="surface-summary">{{ hasRoute ? surfaceSummary : 'No route yet' }}</p>
        <div class="actions-grid">
          <button class="action-button" :disabled="!hasRoute" @click="undoLast">Undo last</button>
          <button class="action-button" :disabled="!hasRoute" @click="clearRoute">Clear route</button>
          <button class="action-button primary" :disabled="!hasRoute" @click="saveRoute">Save route</button>
          <button class="action-button" @click="restoreRoute">Restore saved</button>
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">Map key</h2>
        <div class="legend-grid">
          <div class="legend-item"><span class="swatch paved" />Paved trail</div>
          <div class="legend-item"><span class="swatch gravel" />Gravel trail</div>
          <div class="legend-item"><span class="swatch connector" />Sidewalk / connector</div>
          <div class="legend-item"><span class="swatch closed" />Closed for construction</div>
          <div class="legend-item"><span class="swatch planned" />Planned trail</div>
        </div>
      </section>
      <p class="status-message" role="status">{{ message }}</p>
      <p class="attribution-note">Trail lines: Carver County / City of Chaska. Basemap: © OpenStreetMap contributors. Surface and access details depend on source data. Drawn lines are not turn-by-turn directions; confirm access and closures before heading out.</p>
    </aside>

    <section class="map-panel" aria-label="Map area">
      <div class="map-badge">Chaska, Minnesota <span>·</span> Map first, your choice always</div>
      <ClientOnly>
        <TrailMap :mode="mode" @route-update="updateRoute" @data-status="message = $event" />
        <template #fallback><div class="map-fallback">Preparing the map…</div></template>
      </ClientOnly>
    </section>
  </main>
</template>
