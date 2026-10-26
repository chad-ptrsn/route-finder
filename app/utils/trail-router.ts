export type Position = [number, number]
export type SurfaceGroup = 'paved' | 'gravel' | 'sidewalk' | 'unknown'

export interface TrailEdge {
  a: Position
  b: Position
  group: SurfaceGroup
  name: string
}

export interface TrailRouteSection {
  key: string
  name: string
  group: SurfaceGroup
  parts: Position[][]
}

export interface SnapRouteResult {
  sections: TrailRouteSection[]
  snappedPoints: Position[]
  routeMeters: number
  maxOffsetMeters: number
}

interface Projected { x: number, y: number }
interface Attachment { edgeIndex: number, t: number, coordinate: Position, distance: number }
interface Cut { t: number, coordinate: Position, waypointIndexes: number[] }
interface GraphEdge { to: number, meters: number, a: Position, b: Position, group: SurfaceGroup, name: string }
interface GraphNode { coordinate: Position, x: number, y: number, edges: GraphEdge[] }

const EARTH_METERS_PER_DEGREE = 111_320
const NODE_MERGE_METERS = 3

function project(position: Position, latitudeReference: number): Projected {
  return {
    x: position[0] * EARTH_METERS_PER_DEGREE * Math.cos(latitudeReference * Math.PI / 180),
    y: position[1] * EARTH_METERS_PER_DEGREE,
  }
}

function unproject(point: Projected, latitudeReference: number): Position {
  return [point.x / (EARTH_METERS_PER_DEGREE * Math.cos(latitudeReference * Math.PI / 180)), point.y / EARTH_METERS_PER_DEGREE]
}

function distanceMeters(a: Position, b: Position): number {
  const referenceLatitude = (a[1] + b[1]) / 2
  const pa = project(a, referenceLatitude)
  const pb = project(b, referenceLatitude)
  return Math.hypot(pb.x - pa.x, pb.y - pa.y)
}

function nearestPointOnEdge(point: Position, edge: TrailEdge, latitudeReference: number) {
  const p = project(point, latitudeReference)
  const a = project(edge.a, latitudeReference)
  const b = project(edge.b, latitudeReference)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0
  const nearest = { x: a.x + t * dx, y: a.y + t * dy }
  return { t, coordinate: unproject(nearest, latitudeReference), distance: Math.hypot(p.x - nearest.x, p.y - nearest.y) }
}

class NodeRegistry {
  private nodes: GraphNode[] = []
  private cells = new Map<string, number[]>()

  get(coordinate: Position, latitudeReference: number): number {
    const projected = project(coordinate, latitudeReference)
    const cellX = Math.floor(projected.x / NODE_MERGE_METERS)
    const cellY = Math.floor(projected.y / NODE_MERGE_METERS)
    for (let x = cellX - 1; x <= cellX + 1; x++) {
      for (let y = cellY - 1; y <= cellY + 1; y++) {
        for (const index of this.cells.get(`${x}:${y}`) || []) {
          const node = this.nodes[index]!
          if (Math.hypot(node.x - projected.x, node.y - projected.y) <= NODE_MERGE_METERS) return index
        }
      }
    }
    const index = this.nodes.length
    this.nodes.push({ coordinate, x: projected.x, y: projected.y, edges: [] })
    const key = `${cellX}:${cellY}`
    this.cells.set(key, [...(this.cells.get(key) || []), index])
    return index
  }

  get all(): GraphNode[] { return this.nodes }
}

class MinHeap {
  private values: Array<{ node: number, priority: number }> = []

  push(value: { node: number, priority: number }) {
    this.values.push(value)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.values[parent]!.priority <= value.priority) break
      this.values[index] = this.values[parent]!
      index = parent
    }
    this.values[index] = value
  }

  pop() {
    const first = this.values[0]
    const last = this.values.pop()
    if (!first || !last) return first
    if (this.values.length) {
      let index = 0
      while (true) {
        const left = index * 2 + 1
        const right = left + 1
        if (left >= this.values.length) break
        const child = right < this.values.length && this.values[right]!.priority < this.values[left]!.priority ? right : left
        if (this.values[child]!.priority >= last.priority) break
        this.values[index] = this.values[child]!
        index = child
      }
      this.values[index] = last
    }
    return first
  }

  get size() { return this.values.length }
}

function shortestPath(nodes: GraphNode[], start: number, goal: number): GraphEdge[] | null {
  if (start === goal) return []
  const distance = new Map<number, number>([[start, 0]])
  const previous = new Map<number, { from: number, edge: GraphEdge }>()
  const pending = new MinHeap()
  pending.push({ node: start, priority: 0 })
  while (pending.size) {
    const current = pending.pop()!
    if (current.priority !== distance.get(current.node)) continue
    if (current.node === goal) break
    for (const edge of nodes[current.node]!.edges) {
      const candidate = current.priority + edge.meters
      if (candidate >= (distance.get(edge.to) ?? Infinity)) continue
      distance.set(edge.to, candidate)
      previous.set(edge.to, { from: current.node, edge })
      pending.push({ node: edge.to, priority: candidate })
    }
  }
  if (!previous.has(goal)) return null
  const path: GraphEdge[] = []
  let node = goal
  while (node !== start) {
    const step = previous.get(node)
    if (!step) return null
    path.push(step.edge)
    node = step.from
  }
  return path.reverse()
}

export function routeAcrossTrails(
  waypoints: Position[],
  networkEdges: TrailEdge[],
  maxSnapDistanceMeters: number,
): SnapRouteResult {
  if (waypoints.length < 2) throw new Error('Add at least two points before snapping to trails.')
  if (!networkEdges.length) throw new Error('No routable Chaska trail data is loaded yet.')

  const latitudeReference = waypoints.reduce((sum, point) => sum + point[1], 0) / waypoints.length
  const attachments: Attachment[] = waypoints.map((waypoint) => {
    let nearest: Attachment | undefined
    networkEdges.forEach((edge, edgeIndex) => {
      const candidate = nearestPointOnEdge(waypoint, edge, latitudeReference)
      if (!nearest || candidate.distance < nearest.distance) nearest = { edgeIndex, ...candidate }
    })
    if (!nearest) throw new Error('Could not find a nearby trail segment.')
    if (nearest.distance > maxSnapDistanceMeters) {
      throw new Error(`A point is ${Math.round(nearest.distance)} m from the nearest mapped trail, beyond your ${maxSnapDistanceMeters} m limit. Move it closer or increase the match limit.`)
    }
    return nearest
  })

  const cutsByEdge = new Map<number, Cut[]>()
  networkEdges.forEach((edge, edgeIndex) => cutsByEdge.set(edgeIndex, [
    { t: 0, coordinate: edge.a, waypointIndexes: [] },
    { t: 1, coordinate: edge.b, waypointIndexes: [] },
  ]))
  attachments.forEach((attachment, waypointIndex) => {
    const cuts = cutsByEdge.get(attachment.edgeIndex)!
    const existing = cuts.find(cut => Math.abs(cut.t - attachment.t) < 0.00001)
    if (existing) existing.waypointIndexes.push(waypointIndex)
    else cuts.push({ t: attachment.t, coordinate: attachment.coordinate, waypointIndexes: [waypointIndex] })
  })

  const registry = new NodeRegistry()
  const nodes = registry.all
  const waypointNodes = new Array<number>(waypoints.length)
  for (const [edgeIndex, cuts] of cutsByEdge) {
    const edge = networkEdges[edgeIndex]!
    cuts.sort((a, b) => a.t - b.t)
    const nodeIds = cuts.map((cut) => {
      const nodeId = registry.get(cut.coordinate, latitudeReference)
      cut.waypointIndexes.forEach(index => waypointNodes[index] = nodeId)
      return nodeId
    })
    for (let i = 1; i < cuts.length; i++) {
      const from = nodeIds[i - 1]!
      const to = nodeIds[i]!
      if (from === to) continue
      const fromPosition = nodes[from]!.coordinate
      const toPosition = nodes[to]!.coordinate
      const meters = distanceMeters(fromPosition, toPosition)
      const forward: GraphEdge = { to, meters, a: fromPosition, b: toPosition, group: edge.group, name: edge.name }
      const reverse: GraphEdge = { to: from, meters, a: toPosition, b: fromPosition, group: edge.group, name: edge.name }
      nodes[from]!.edges.push(forward)
      nodes[to]!.edges.push(reverse)
    }
  }

  if (waypointNodes.some(node => node === undefined)) throw new Error('Could not connect each point to the trail network.')
  const path: GraphEdge[] = []
  for (let i = 1; i < waypointNodes.length; i++) {
    const leg = shortestPath(nodes, waypointNodes[i - 1]!, waypointNodes[i]!)
    if (!leg) throw new Error(`The snapped points ${i} and ${i + 1} are not connected by the mapped trail network.`)
    path.push(...leg)
  }
  if (!path.length) throw new Error('Your points snapped to the same place. Spread them farther apart along the trail.')

  const groups: Array<{ group: SurfaceGroup, coords: Position[] }> = []
  for (const edge of path) {
    const last = groups.at(-1)
    if (last?.group === edge.group) last.coords.push(edge.b)
    else groups.push({ group: edge.group, coords: [edge.a, edge.b] })
  }
  const sections = groups.map((group, index) => ({
    key: `snapped-${Date.now()}-${index}`,
    name: group.group === 'paved' ? 'Mapped paved trail' : group.group === 'gravel' ? 'Mapped gravel trail' : 'Mapped sidewalk / connector',
    group: group.group,
    parts: [group.coords],
  }))
  const routeMeters = path.reduce((sum, edge) => sum + edge.meters, 0)
  return {
    sections,
    snappedPoints: attachments.map(attachment => attachment.coordinate),
    routeMeters,
    maxOffsetMeters: Math.max(...attachments.map(attachment => attachment.distance)),
  }
}
