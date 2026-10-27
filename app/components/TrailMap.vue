<script setup lang="ts">
import type { Map as MapLibreMap, MapMouseEvent, MapTouchEvent } from 'maplibre-gl'
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { nearestTrailDistanceMeters, routeAcrossTrails, SnapRouteError, type Position, type SurfaceGroup, type TrailEdge, type TrailRouteSection } from '~/utils/trail-router'

type Mode = 'draw' | 'select'
type RouteSection = TrailRouteSection
type SnapState = { status: 'loading' | 'ready' | 'working' | 'preview' | 'error' | 'accepted', message: string, routeMeters?: number, maxOffsetMeters?: number }

const props = defineProps<{
  mode: Mode
  routeAction: { type: 'clear' | 'undo' | 'snap' | 'accept-snap' | 'keep-drawing' | 'restore' | 'focus-route', revision: number, drawCoords?: Position[], selected?: RouteSection[], focusCoords?: Position[], focusDrawCoords?: Position[], focusSections?: RouteSection[] }
  snapToleranceMeters: number
}>()
const emit = defineEmits<{
  routeUpdate: [payload: { drawCoords: Position[], selected: RouteSection[] }]
  dataStatus: [message: string]
  snapState: [state: SnapState]
}>()

const serviceUrl = 'https://gis.co.carver.mn.us/arcgis_ca/rest/services/Chaska/Chaska_ParksRec_Trails/FeatureServer'
const layerSpecs = [
  { id: 2, name: 'Paved trail', color: '#538563', group: 'paved' as const },
  { id: 3, name: 'Gravel trail', color: '#d39147', group: 'gravel' as const },
  { id: 4, name: 'Sidewalk', color: '#8191a0', group: 'sidewalk' as const },
  { id: 5, name: 'Association trail', color: '#719a76', group: 'unknown' as const },
  { id: 6, name: 'Crosswalk', color: '#8191a0', group: 'sidewalk' as const },
  { id: 0, name: 'Trail bridge', color: '#538563', group: 'unknown' as const },
  { id: 1, name: 'Trail underpass', color: '#538563', group: 'unknown' as const },
  { id: 8, name: 'Planned paved trail', color: '#9a7ab4', group: 'unknown' as const, dash: [2, 2], selectable: false },
  { id: 9, name: 'Closed for construction', color: '#cf5c4d', group: 'unknown' as const, dash: [1, 1], selectable: false },
]
const layerIds = layerSpecs.map(spec => `city-trail-${spec.id}`)
let map: MapLibreMap | undefined
let drawCoords: Position[] = []
let selected: RouteSection[] = []
let loadedLayers = 0
let networkEdges: TrailEdge[] = []
let snapPreview: ReturnType<typeof routeAcrossTrails> | undefined
let snapFailurePointIndex: number | undefined
let draggingPointIndex: number | undefined
let suppressClickAfterDrag = false

function publishRoute() {
  emit('routeUpdate', { drawCoords: [...drawCoords], selected: selected.map(section => ({ ...section, parts: section.parts.map(part => [...part]) })) })
  const features: GeoJSON.Feature[] = []
  selected.forEach((section, index) => section.parts.forEach(part => {
    if (part.length > 1) features.push({ type: 'Feature', properties: { kind: section.group, index }, geometry: { type: 'LineString', coordinates: part } })
  }))
  if (drawCoords.length > 1) features.push({ type: 'Feature', properties: { kind: 'drawn' }, geometry: { type: 'LineString', coordinates: drawCoords } })
  drawCoords.forEach((coordinate, index) => features.push({
    type: 'Feature',
    properties: { kind: 'point', pointIndex: index, snapError: index === snapFailurePointIndex },
    geometry: { type: 'Point', coordinates: coordinate },
  }))
  map?.getSource('user-route')?.setData({ type: 'FeatureCollection', features })
  const previewFeatures: GeoJSON.Feature[] = []
  snapPreview?.sections.forEach(section => section.parts.forEach(part => previewFeatures.push({
    type: 'Feature', properties: { group: section.group }, geometry: { type: 'LineString', coordinates: part },
  })))
  snapPreview?.snappedPoints.forEach(coordinate => previewFeatures.push({
    type: 'Feature', properties: { kind: 'snap-point' }, geometry: { type: 'Point', coordinates: coordinate },
  }))
  map?.getSource('snap-preview')?.setData({ type: 'FeatureCollection', features: previewFeatures })
}

function clearSavedRouteFocus() {
  map?.getSource('saved-route-focus')?.setData({ type: 'FeatureCollection', features: [] })
}

async function updateSnapPreview() {
  if (drawCoords.length < 2) {
    emit('snapState', { status: 'error', message: 'Add at least two points before snapping to trails.' })
    return
  }
  emit('snapState', { status: 'working', message: 'Finding the connected trail path…' })
  snapFailurePointIndex = undefined
  try {
    snapPreview = routeAcrossTrails(drawCoords, networkEdges, props.snapToleranceMeters)
    publishRoute()
    emit('snapState', {
      status: 'preview',
      message: `Preview: ${(snapPreview.routeMeters / 1609.344).toFixed(2)} mi on mapped paths · farthest point moved ${Math.round(snapPreview.maxOffsetMeters)} m.`,
      routeMeters: snapPreview.routeMeters,
      maxOffsetMeters: snapPreview.maxOffsetMeters,
    })
  }
  catch (error) {
    snapPreview = undefined
    snapFailurePointIndex = error instanceof SnapRouteError ? error.waypointIndex : undefined
    publishRoute()
    emit('snapState', { status: 'error', message: error instanceof Error ? error.message : 'Could not find a connected trail path.' })
  }
}

watch(() => props.routeAction.revision, async () => {
  if (props.routeAction.type === 'clear') {
    drawCoords = []
    selected = []
    snapPreview = undefined
    snapFailurePointIndex = undefined
    clearSavedRouteFocus()
    emit('snapState', { status: 'ready', message: 'Draw a route, then preview a snap to mapped city trails.' })
  }
  else if (props.routeAction.type === 'undo') {
    if (drawCoords.length) drawCoords.pop()
    else selected.pop()
    snapPreview = undefined
    snapFailurePointIndex = undefined
    emit('snapState', { status: 'ready', message: 'Last route addition removed.' })
  }
  else if (props.routeAction.type === 'snap') {
    await updateSnapPreview()
  }
  else if (props.routeAction.type === 'accept-snap' && snapPreview) {
    selected = [...selected, ...snapPreview.sections]
    drawCoords = []
    snapPreview = undefined
    snapFailurePointIndex = undefined
    emit('snapState', { status: 'accepted', message: 'Snapped trail route accepted. You can keep editing or clear it.' })
  }
  else if (props.routeAction.type === 'keep-drawing') {
    snapPreview = undefined
    snapFailurePointIndex = undefined
    emit('snapState', { status: 'ready', message: 'Kept your original drawing. Adjust it or preview another snap.' })
  }
  else if (props.routeAction.type === 'restore') {
    drawCoords = props.routeAction.drawCoords || []
    selected = props.routeAction.selected || []
    snapPreview = undefined
    snapFailurePointIndex = undefined
    clearSavedRouteFocus()
    emit('snapState', { status: 'ready', message: 'Restored route. You can continue editing or preview a snap for the drawn section.' })
  }
  else if (props.routeAction.type === 'focus-route') {
    const coordinates = props.routeAction.focusCoords || []
    if (!map || !coordinates.length) return
    const features: GeoJSON.Feature[] = []
    props.routeAction.focusSections?.forEach((section, index) => section.parts.forEach(part => {
      if (part.length > 1) features.push({ type: 'Feature', properties: { index }, geometry: { type: 'LineString', coordinates: part } })
    }))
    const drawnCoordinates = props.routeAction.focusDrawCoords || []
    if (drawnCoordinates.length > 1) features.push({ type: 'Feature', properties: { kind: 'drawn' }, geometry: { type: 'LineString', coordinates: drawnCoordinates } })
    map.getSource('saved-route-focus')?.setData({ type: 'FeatureCollection', features })
    const maplibre = await import('maplibre-gl')
    const bounds = new maplibre.LngLatBounds(coordinates[0], coordinates[0])
    coordinates.slice(1).forEach(coordinate => bounds.extend(coordinate))
    map.fitBounds(bounds, { padding: { top: 70, right: 55, bottom: 70, left: 55 }, maxZoom: 16.5, duration: 800 })
    return
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
  if (suppressClickAfterDrag) {
    suppressClickAfterDrag = false
    return
  }
  if (props.mode === 'draw') {
    clearSavedRouteFocus()
    if (snapPreview) {
      snapPreview = undefined
      emit('snapState', { status: 'ready', message: 'Route changed. Preview another snap when ready.' })
    }
    snapFailurePointIndex = undefined
    drawCoords.push([event.lngLat.lng, event.lngLat.lat])
    publishRoute()
    return
  }

  const hits = map.queryRenderedFeatures(event.point, { layers: layerIds.filter(id => map?.getLayer(id)) })
  // Planned and closed trails are drawn for context and can overlap existing
  // selectable paths. Prefer an existing path under the click when both match.
  const hit = hits.find((feature) => {
    const featureLayerId = Number(feature.layer.id.replace('city-trail-', ''))
    const featureSpec = layerSpecs.find(layer => layer.id === featureLayerId)
    return featureSpec && (!('selectable' in featureSpec) || featureSpec.selectable !== false)
  }) || hits[0]
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

function startPointDrag(event: MapMouseEvent | MapTouchEvent) {
  if (!map || props.mode !== 'draw' || snapFailurePointIndex === undefined) return
  const hit = map.queryRenderedFeatures(event.point, { layers: ['route-points'] })
    .find(feature => feature.properties?.snapError === true)
  const pointIndex = Number(hit?.properties?.pointIndex)
  if (!hit || !Number.isInteger(pointIndex) || pointIndex !== snapFailurePointIndex) return

  draggingPointIndex = pointIndex
  snapPreview = undefined
  map.dragPan.disable()
  map.getCanvas().style.cursor = 'grabbing'
  event.preventDefault()
}

function moveDraggedPoint(event: MapMouseEvent | MapTouchEvent) {
  if (!map || draggingPointIndex === undefined) return
  const pointIndex = draggingPointIndex
  const coordinate: Position = [event.lngLat.lng, event.lngLat.lat]
  drawCoords[pointIndex] = coordinate
  const distance = nearestTrailDistanceMeters(coordinate, networkEdges)
  const withinLimit = distance <= props.snapToleranceMeters
  snapFailurePointIndex = withinLimit ? undefined : pointIndex
  publishRoute()
  emit('snapState', {
    status: withinLimit ? 'ready' : 'error',
    message: withinLimit
      ? `Point ${pointIndex + 1} is ${Math.round(distance)} m from a mapped trail and is within your ${props.snapToleranceMeters} m limit.`
      : `Point ${pointIndex + 1} is ${Math.round(distance)} m from the nearest routable Chaska trail. Drag it within ${props.snapToleranceMeters} m to retry the preview.`,
  })
  event.preventDefault()
}

function endPointDrag() {
  if (!map || draggingPointIndex === undefined) return
  draggingPointIndex = undefined
  map.dragPan.enable()
  map.getCanvas().style.cursor = ''
  suppressClickAfterDrag = true
  window.setTimeout(() => { suppressClickAfterDrag = false }, 0)
  publishRoute()
  if (snapFailurePointIndex === undefined) {
    emit('snapState', { status: 'ready', message: 'The point is within range. Preview the snap again when ready.' })
  }
}

async function loadLayer(spec: typeof layerSpecs[number]) {
  const url = `${serviceUrl}/${spec.id}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const geojson = await response.json()
  if (geojson.error) throw new Error(geojson.error.message || 'Service error')
  if (!('selectable' in spec && spec.selectable === false)) {
    for (const feature of geojson.features || []) {
      for (const part of lineParts(feature.geometry)) {
        for (let index = 1; index < part.length; index++) {
          networkEdges.push({ a: part[index - 1]!, b: part[index]!, group: spec.group, name: spec.name })
        }
      }
    }
  }
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
  }, 'route-casing')
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
    map!.addSource('snap-preview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map!.addSource('saved-route-focus', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map!.addLayer({ id: 'route-casing', type: 'line', source: 'user-route', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#fffefa', 'line-width': 10, 'line-opacity': 0.98 } })
    map!.addLayer({ id: 'route-line', type: 'line', source: 'user-route', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#245bdb', 'line-width': 6, 'line-opacity': 1 } })
    map!.addLayer({ id: 'route-points', type: 'circle', source: 'user-route', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7, 'circle-color': ['case', ['==', ['get', 'snapError'], true], '#cf5c4d', '#315f42'], 'circle-stroke-color': '#fffefa', 'circle-stroke-width': 2 } })
    map!.addLayer({ id: 'saved-route-focus-casing', type: 'line', source: 'saved-route-focus', paint: { 'line-color': '#fffefa', 'line-width': 14, 'line-opacity': 0.98 } })
    map!.addLayer({ id: 'saved-route-focus-line', type: 'line', source: 'saved-route-focus', paint: { 'line-color': '#245bdb', 'line-width': 8, 'line-opacity': 1 } })
    map!.addLayer({ id: 'snap-preview-line', type: 'line', source: 'snap-preview', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#287fa7', 'line-width': 6, 'line-opacity': 0.96, 'line-dasharray': [1.5, 1.2] } })
    map!.addLayer({ id: 'snap-preview-points', type: 'circle', source: 'snap-preview', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#287fa7', 'circle-stroke-color': '#fffefa', 'circle-stroke-width': 2 } })
    const results = await Promise.allSettled(layerSpecs.map(loadLayer))
    const failedLayers = results.filter(result => result.status === 'rejected').length
    emit('dataStatus', loadedLayers
      ? `${loadedLayers} Chaska trail layers loaded${failedLayers ? ` · ${failedLayers} unavailable` : ''}. Tap a trail for details.`
      : 'The Chaska trail service did not load. Check the connection and reload the page.')
    emit('snapState', networkEdges.length
      ? { status: 'ready', message: 'Ready to preview a snap to mapped city trails and connectors.' }
      : { status: 'error', message: 'No routable city trail data loaded. Check the trail service connection.' })
    publishRoute()
  })
  map.on('click', onMapClick)
  map.on('mousedown', startPointDrag)
  map.on('touchstart', startPointDrag)
  map.on('mousemove', (event) => {
    if (draggingPointIndex !== undefined) {
      moveDraggedPoint(event)
      return
    }
    if (props.mode === 'draw') {
      const hit = snapFailurePointIndex !== undefined && map!.queryRenderedFeatures(event.point, { layers: ['route-points'] })
        .some(feature => feature.properties?.snapError === true)
      map!.getCanvas().style.cursor = hit ? 'grab' : ''
      return
    }
    if (props.mode !== 'select') {
      map!.getCanvas().style.cursor = ''
      return
    }
    const hit = map!.queryRenderedFeatures(event.point, { layers: layerIds.filter(id => map!.getLayer(id)) }).length > 0
    map!.getCanvas().style.cursor = hit ? 'pointer' : ''
  })
  map.on('touchmove', moveDraggedPoint)
  map.on('mouseup', endPointDrag)
  map.on('touchend', endPointDrag)
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
