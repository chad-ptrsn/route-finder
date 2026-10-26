<script setup lang="ts">
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl'
import { onBeforeUnmount, onMounted, watch } from 'vue'

type Mode = 'draw' | 'select'
type Position = [number, number]
type SurfaceGroup = 'paved' | 'gravel' | 'sidewalk' | 'unknown'
interface RouteSection { key: string, name: string, group: SurfaceGroup, parts: Position[][] }

const props = defineProps<{
  mode: Mode
  routeAction: { type: 'clear' | 'undo', revision: number }
}>()
const emit = defineEmits<{
  routeUpdate: [payload: { drawCoords: Position[], selected: RouteSection[] }]
  dataStatus: [message: string]
}>()

const serviceUrl = 'https://gis.co.carver.mn.us/arcgis_ca/rest/services/Chaska/Chaska_ParksRec_Trails/FeatureServer'
const layerSpecs = [
  { id: 2, name: 'Paved trail', color: '#538563', group: 'paved' as const },
  { id: 3, name: 'Gravel trail', color: '#d39147', group: 'gravel' as const },
  { id: 4, name: 'Sidewalk', color: '#8191a0', group: 'sidewalk' as const },
  { id: 5, name: 'Association trail', color: '#719a76', group: 'paved' as const },
  { id: 6, name: 'Crosswalk', color: '#8191a0', group: 'sidewalk' as const },
  { id: 0, name: 'Trail bridge', color: '#538563', group: 'paved' as const },
  { id: 1, name: 'Trail underpass', color: '#538563', group: 'paved' as const },
  { id: 8, name: 'Planned paved trail', color: '#9a7ab4', group: 'unknown' as const, dash: [2, 2], selectable: false },
  { id: 9, name: 'Closed for construction', color: '#cf5c4d', group: 'unknown' as const, dash: [1, 1], selectable: false },
]
const layerIds = layerSpecs.map(spec => `city-trail-${spec.id}`)
let map: MapLibreMap | undefined
let drawCoords: Position[] = []
let selected: RouteSection[] = []
let loadedLayers = 0

function publishRoute() {
  emit('routeUpdate', { drawCoords: [...drawCoords], selected: selected.map(section => ({ ...section, parts: section.parts.map(part => [...part]) })) })
  const features: GeoJSON.Feature[] = []
  selected.forEach((section, index) => section.parts.forEach(part => {
    if (part.length > 1) features.push({ type: 'Feature', properties: { kind: section.group, index }, geometry: { type: 'LineString', coordinates: part } })
  }))
  if (drawCoords.length > 1) features.push({ type: 'Feature', properties: { kind: 'drawn' }, geometry: { type: 'LineString', coordinates: drawCoords } })
  drawCoords.forEach(coordinate => features.push({ type: 'Feature', properties: { kind: 'point' }, geometry: { type: 'Point', coordinates: coordinate } }))
  map?.getSource('user-route')?.setData({ type: 'FeatureCollection', features })
}

watch(() => props.routeAction.revision, () => {
  if (props.routeAction.type === 'clear') {
    drawCoords = []
    selected = []
  }
  else if (props.routeAction.type === 'undo' && drawCoords.length) {
    drawCoords.pop()
  }
  else return

  publishRoute()
})

function lineParts(geometry: GeoJSON.Geometry | null): Position[][] {
  if (!geometry) return []
  if (geometry.type === 'LineString') return [geometry.coordinates as Position[]]
  if (geometry.type === 'MultiLineString') return geometry.coordinates as Position[][]
  return []
}

async function onMapClick(event: MapMouseEvent) {
  if (!map) return
  if (props.mode === 'draw') {
    drawCoords.push([event.lngLat.lng, event.lngLat.lat])
    publishRoute()
    return
  }

  const hits = map.queryRenderedFeatures(event.point, { layers: layerIds.filter(id => map?.getLayer(id)) })
  const hit = hits[0]
  if (!hit) return
  const layerId = Number(hit.layer.id.replace('city-trail-', ''))
  const spec = layerSpecs.find(layer => layer.id === layerId)
  if (!spec) return
  if ('selectable' in spec && spec.selectable === false) {
    const content = document.createElement('div')
    content.textContent = `${spec.name} · shown for context, not added to your route.`
    const maplibre = await import('maplibre-gl')
    new maplibre.Popup({ closeButton: true, offset: 8 }).setLngLat(event.lngLat).setDOMContent(content).addTo(map)
    return
  }
  const parts = lineParts(hit.geometry as GeoJSON.Geometry)
  if (!parts.length) return
  const key = `${layerId}:${hit.id ?? JSON.stringify(parts[0]?.[0])}`
  const existingIndex = selected.findIndex(section => section.key === key)
  if (existingIndex >= 0) selected.splice(existingIndex, 1)
  else selected.push({ key, name: spec.name, group: spec.group, parts })
  publishRoute()

  const content = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = spec.name
  content.append(title)
  Object.entries(hit.properties || {})
    .filter(([name, value]) => value !== null && value !== '' && !name.toLowerCase().includes('shape'))
    .slice(0, 4)
    .forEach(([name, value]) => {
      const row = document.createElement('div')
      const label = document.createElement('strong')
      label.textContent = `${name.replaceAll('_', ' ')}: `
      row.append(label, document.createTextNode(String(value)))
      content.append(row)
    })
  const maplibre = await import('maplibre-gl')
  new maplibre.Popup({ closeButton: true, offset: 8 }).setLngLat(event.lngLat).setDOMContent(content).addTo(map)
}

async function loadLayer(spec: typeof layerSpecs[number]) {
  const url = `${serviceUrl}/${spec.id}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const geojson = await response.json()
  if (geojson.error) throw new Error(geojson.error.message || 'Service error')
  const sourceId = `source-${spec.id}`
  const lineId = `city-trail-${spec.id}`
  map!.addSource(sourceId, { type: 'geojson', data: geojson })
  map!.addLayer({
    id: lineId,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': spec.color,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 15, 4.3],
      'line-opacity': spec.dash ? 0.75 : 0.92,
      ...(spec.dash ? { 'line-dasharray': spec.dash } : {}),
    },
  })
  loadedLayers++
}

onMounted(async () => {
  const maplibre = await import('maplibre-gl')
  maplibre.setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).toString())
  map = new maplibre.Map({
    container: 'chaska-map',
    center: [-93.602, 44.789],
    zoom: 12.7,
    cooperativeGestures: true,
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
  })
  map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right')
  map.addControl(new maplibre.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'top-right')
  map.on('load', async () => {
    map!.addSource('user-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map!.addLayer({ id: 'route-casing', type: 'line', source: 'user-route', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#fffefa', 'line-width': 8, 'line-opacity': 0.95 } })
    map!.addLayer({ id: 'route-line', type: 'line', source: 'user-route', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#315f42', 'line-width': 4, 'line-opacity': 0.98 } })
    map!.addLayer({ id: 'route-points', type: 'circle', source: 'user-route', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#315f42', 'circle-stroke-color': '#fffefa', 'circle-stroke-width': 2 } })
    const results = await Promise.allSettled(layerSpecs.map(loadLayer))
    const failedLayers = results.filter(result => result.status === 'rejected').length
    emit('dataStatus', loadedLayers
      ? `${loadedLayers} Chaska trail layers loaded${failedLayers ? ` · ${failedLayers} unavailable` : ''}. Tap a trail for details.`
      : 'The Chaska trail service did not load. Check the connection and reload the page.')
    publishRoute()
  })
  map.on('click', onMapClick)
  map.on('mousemove', (event) => {
    if (props.mode !== 'select') {
      map!.getCanvas().style.cursor = ''
      return
    }
    const hit = map!.queryRenderedFeatures(event.point, { layers: layerIds.filter(id => map!.getLayer(id)) }).length > 0
    map!.getCanvas().style.cursor = hit ? 'pointer' : ''
  })
})

watch(() => props.mode, () => {
  if (map) map.getCanvas().style.cursor = ''
})

onBeforeUnmount(() => {
  map?.remove()
  map = undefined
})
</script>

<template>
  <div id="chaska-map" class="map-canvas" aria-label="Interactive map of trails and roads in Chaska" />
</template>
