<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

type RouteMode = 'draw' | 'select'
type SurfaceGroup = 'paved' | 'gravel' | 'sidewalk' | 'unknown'
type Position = [number, number]
interface RouteSection { key: string, name: string, group: SurfaceGroup, parts: Position[][] }
interface SavedRoute { id: string, name: string, savedAt: string, drawCoords: Position[], selected: RouteSection[] }
type RouteActionType = 'clear' | 'undo' | 'snap' | 'accept-snap' | 'keep-drawing' | 'restore' | 'focus-route'
interface SnapState { status: 'loading' | 'ready' | 'working' | 'preview' | 'error' | 'accepted', message: string, routeMeters?: number, maxOffsetMeters?: number }

const mode = ref<RouteMode>('draw')
const drawCoords = ref<Position[]>([])
const selectedSections = ref<RouteSection[]>([])
const message = ref('Loading Chaska trail layers…')
const routeAction = ref<{ type: RouteActionType, revision: number, drawCoords?: Position[], selected?: RouteSection[], focusCoords?: Position[], focusDrawCoords?: Position[], focusSections?: RouteSection[] }>({ type: 'clear', revision: 0 })
const snapToleranceMeters = ref(35)
const snapState = ref<SnapState>({ status: 'loading', message: 'Loading the local trail network…' })
const saveKey = 'chaska-adventure-route-v1'
const savedRoutes = ref<SavedRoute[]>([])
const editingSavedRouteId = ref<string | null>(null)
const focusedSavedRouteId = ref<string | null>(null)
const saveNameOpen = ref(false)
const routeNameDraft = ref('')

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
const editingSavedRoute = computed(() => savedRoutes.value.find(route => route.id === editingSavedRouteId.value))
const canUndo = computed(() => drawCoords.value.length > 0 || selectedSections.value.length > 0)
const canRequestSnap = computed(() => drawCoords.value.length >= 2 && snapState.value.status !== 'loading' && snapState.value.status !== 'working')

function cloneRouteData(draw: Position[], sections: RouteSection[]): Pick<SavedRoute, 'drawCoords' | 'selected'> {
  return {
    drawCoords: draw.map(point => [...point] as Position),
    selected: sections.map(section => ({
      ...section,
      parts: section.parts.map(part => part.map(point => [...point] as Position)),
    })),
  }
}

function currentRouteData() {
  return cloneRouteData(drawCoords.value, selectedSections.value)
}

function persistSavedRoutes() {
  localStorage.setItem(saveKey, JSON.stringify({ routes: savedRoutes.value }))
}

function loadSavedRoutes() {
  try {
    const stored = JSON.parse(localStorage.getItem(saveKey) || 'null')
    if (Array.isArray(stored?.routes)) {
      savedRoutes.value = stored.routes
      return
    }
    // Keep the single route saved by the earlier prototype as the first list item.
    if (stored && Array.isArray(stored.drawCoords) && Array.isArray(stored.selected)) {
      savedRoutes.value = [{
        id: `route-${Date.now().toString(36)}`,
        name: 'Saved route',
        savedAt: stored.savedAt || new Date().toISOString(),
        ...cloneRouteData(stored.drawCoords, stored.selected),
      }]
      persistSavedRoutes()
    }
  }
  catch {
    savedRoutes.value = []
    message.value = 'Could not read saved routes from this browser.'
  }
}

onMounted(loadSavedRoutes)

function updateRoute(payload: { drawCoords: Position[], selected: RouteSection[] }) {
  drawCoords.value = payload.drawCoords
  selectedSections.value = payload.selected
}

function saveRoute() {
  if (!hasRoute.value) return
  if (editingSavedRouteId.value) {
    const index = savedRoutes.value.findIndex(route => route.id === editingSavedRouteId.value)
    if (index < 0) return
    const existing = savedRoutes.value[index]!
    savedRoutes.value[index] = { ...existing, ...currentRouteData(), savedAt: new Date().toISOString() }
    persistSavedRoutes()
    message.value = `Saved changes to “${existing.name}”.`
    return
  }
  routeNameDraft.value = `Route ${savedRoutes.value.length + 1}`
  saveNameOpen.value = true
}

function confirmSaveRoute() {
  const name = routeNameDraft.value.trim() || `Route ${savedRoutes.value.length + 1}`
  const route: SavedRoute = {
    id: globalThis.crypto?.randomUUID?.() || `route-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    savedAt: new Date().toISOString(),
    ...currentRouteData(),
  }
  savedRoutes.value = [route, ...savedRoutes.value]
  persistSavedRoutes()
  saveNameOpen.value = false
  editingSavedRouteId.value = route.id
  focusedSavedRouteId.value = route.id
  message.value = `Saved “${route.name}”. You can add more and save changes to this route.`
}

function editSavedRoute(route: SavedRoute) {
  editingSavedRouteId.value = route.id
  focusedSavedRouteId.value = route.id
  saveNameOpen.value = false
  routeNameDraft.value = route.name
  const routeData = cloneRouteData(route.drawCoords, route.selected)
  routeAction.value = {
    type: 'restore',
    revision: routeAction.value.revision + 1,
    ...routeData,
  }
  message.value = `Editing “${route.name}”. Add trail sections or draw more, then save changes.`
}

function focusSavedRoute(route: SavedRoute) {
  focusedSavedRouteId.value = route.id
  const focusCoords = [
    ...route.drawCoords,
    ...route.selected.flatMap(section => section.parts.flat()),
  ]
  routeAction.value = {
    type: 'focus-route',
    revision: routeAction.value.revision + 1,
    focusCoords,
    focusDrawCoords: route.drawCoords,
    focusSections: route.selected,
  }
}

function stopEditingSavedRoute() {
  editingSavedRouteId.value = null
  message.value = 'Stopped editing the saved route. The current route remains in the builder.'
}

function cancelSaveRoute() {
  saveNameOpen.value = false
}

function savedRouteDistance(route: SavedRoute) {
  const meters = route.selected.reduce((sum, section) => sum + sectionMeters(section), 0)
    + (route.drawCoords.length > 1 ? lengthMeters(route.drawCoords) : 0)
  return `${(meters / 1609.344).toFixed(2)} mi`
}

function savedRouteSurface(route: SavedRoute) {
  const totals = savedRouteSurfaceTotals(route)
  if (totals.gravel > 0 && totals.unknown === 0) return 'Gravel'
  if (totals.paved > 0 && totals.unknown === 0) return 'Paved'
  if (totals.unknown > 0) return 'Some surface unknown'
  return 'Mapped trails'
}

function savedRouteSurfaceTotals(route: SavedRoute) {
  const totals: Record<SurfaceGroup, number> = { paved: 0, gravel: 0, sidewalk: 0, unknown: 0 }
  route.selected.forEach(section => totals[section.group] += sectionMeters(section))
  if (route.drawCoords.length > 1) totals.unknown += lengthMeters(route.drawCoords)
  return totals
}

function savedRouteKnownPercent(route: SavedRoute) {
  const totals = savedRouteSurfaceTotals(route)
  const total = Object.values(totals).reduce((sum, meters) => sum + meters, 0)
  const known = total - totals.unknown
  return total ? `${Math.round(known / total * 100)}%` : '—'
}

function savedRouteSurfaceSummary(route: SavedRoute) {
  const totals = savedRouteSurfaceTotals(route)
  const miles = (meters: number) => `${(meters / 1609.344).toFixed(1)} mi`
  return `${miles(totals.paved)} paved · ${miles(totals.gravel)} gravel · ${miles(totals.sidewalk)} connector · ${miles(totals.unknown)} unknown`
}

function clearRoute() {
  routeAction.value = { type: 'clear', revision: routeAction.value.revision + 1 }
}

function undoLast() {
  if (!canUndo.value) return
  routeAction.value = { type: 'undo', revision: routeAction.value.revision + 1 }
}

function requestSnap() {
  if (!canRequestSnap.value) return
  routeAction.value = { type: 'snap', revision: routeAction.value.revision + 1 }
}

function acceptSnap() {
  routeAction.value = { type: 'accept-snap', revision: routeAction.value.revision + 1 }
}

function keepDrawing() {
  routeAction.value = { type: 'keep-drawing', revision: routeAction.value.revision + 1 }
}
</script>

<template>
  <main class="app-shell">
    <aside class="side-panel">
      <div class="brand">Your route, your way</div>
      <h1>Build your own route.</h1>
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
        <div v-if="mode === 'draw'" class="snap-controls">
          <label class="snap-label" for="snap-distance">Maximum snap distance <strong>{{ snapToleranceMeters }} m</strong></label>
          <input id="snap-distance" v-model.number="snapToleranceMeters" class="snap-slider" type="range" min="10" max="80" step="5" :disabled="snapState.status === 'preview' || snapState.status === 'working'">
          <button class="action-button primary snap-button" :disabled="!canRequestSnap" @click="requestSnap">
            {{ snapState.status === 'working' ? 'Finding a connected path…' : 'Preview snap to trails' }}
          </button>
          <p class="snap-message" :class="{ 'snap-error': snapState.status === 'error' }" role="status">{{ snapState.message }}</p>
          <div v-if="snapState.status === 'preview'" class="snap-decisions">
            <button class="action-button primary" @click="acceptSnap">Use snapped route</button>
            <button class="action-button" @click="keepDrawing">Keep my drawing</button>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">Your route</h2>
        <div v-if="editingSavedRoute" class="editing-route-banner">
          <span>Editing saved route: <strong>{{ editingSavedRoute.name }}</strong></span>
          <button class="text-button" @click="stopEditingSavedRoute">Stop editing</button>
        </div>
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
        <p v-if="drawCoords.length > 1" class="stat-sub">The hand-drawn section is an estimate. Its surface stays unknown until you accept a snap to mapped trails; basemap colors alone don’t provide route data.</p>
        <div class="actions-grid">
          <button class="action-button" :disabled="!canUndo" @click="undoLast">Undo last</button>
          <button class="action-button" :disabled="!hasRoute" @click="clearRoute">Clear route</button>
          <button class="action-button primary" :disabled="!hasRoute" @click="saveRoute">{{ editingSavedRouteId ? 'Save changes' : 'Save route' }}</button>
        </div>
        <div v-if="saveNameOpen" class="save-name-form">
          <label class="stat-label" for="route-name">Name this route</label>
          <input id="route-name" v-model="routeNameDraft" class="route-name-input" maxlength="60" @keydown.enter="confirmSaveRoute">
          <div class="save-name-actions">
            <button class="action-button primary" @click="confirmSaveRoute">Save</button>
            <button class="action-button" @click="cancelSaveRoute">Cancel</button>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">Saved routes</h2>
        <p v-if="!savedRoutes.length" class="saved-routes-empty">Saved routes stay in this browser on this device.</p>
        <div v-else class="saved-routes-list">
          <article v-for="route in savedRoutes" :key="route.id" class="saved-route-item">
            <button type="button" class="saved-route-focus" :aria-label="`Focus map on ${route.name}`" @click="focusSavedRoute(route)">
              <span class="saved-route-info">
                <strong class="saved-route-name">{{ route.name }}</strong>
                <span class="saved-route-meta">{{ savedRouteDistance(route) }} · {{ savedRouteSurface(route) }}</span>
              </span>
            </button>
            <button class="action-button saved-route-edit" :disabled="editingSavedRouteId === route.id" @click="editSavedRoute(route)">
              {{ editingSavedRouteId === route.id ? 'Editing' : 'Edit route' }}
            </button>
            <div v-if="focusedSavedRouteId === route.id" class="saved-route-details">
              <div class="saved-route-detail-grid">
                <div><span>Distance</span><strong>{{ savedRouteDistance(route) }}</strong></div>
                <div><span>Known surface</span><strong>{{ savedRouteKnownPercent(route) }}</strong></div>
              </div>
              <p>{{ savedRouteSurfaceSummary(route) }}</p>
              <small>Saved {{ new Date(route.savedAt).toLocaleDateString() }}</small>
            </div>
          </article>
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
      <p class="attribution-note">Snap coverage: mapped Chaska trails, sidewalks, and connectors. Planned and closed trails are excluded; basemap streets are visible but not routable yet. Trail data and access may be incomplete. Confirm conditions before heading out.</p>
    </aside>

    <section class="map-panel" aria-label="Map area">
      <div class="map-badge">Chaska, Minnesota <span>·</span> Map first, your choice always</div>
      <ClientOnly>
        <TrailMap :mode="mode" :route-action="routeAction" :snap-tolerance-meters="snapToleranceMeters" @route-update="updateRoute" @data-status="message = $event" @snap-state="snapState = $event" />
        <template #fallback><div class="map-fallback">Preparing the map…</div></template>
      </ClientOnly>
    </section>
  </main>
</template>
