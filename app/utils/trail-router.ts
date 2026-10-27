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

export class SnapRouteError extends Error {
  constructor(message: string, readonly waypointIndex?: number) {
    super(message)
    this.name = 'SnapRouteError'
  }
}

interface Projected { x: number, y: number }
interface Attachment { edgeIndex: number, t: number, coordinate: Position, distance: number }
interface Cut { t: number, coordinate: Position }
interface GraphEdge { to: number, meters: number, a: Position, b: Position, group: SurfaceGroup, name: string }
interface GraphNode { coordinate: Position, x: number, y: number, edges: GraphEdge[] }

const MAX_CANDIDATES_PER_WAYPOINT = 5
const CANDIDATE_DISTANCE_MARGIN_METERS = 12
const SNAP_OFFSET_WEIGHT = 2
const COLLAPSED_LEG_PENALTY = 4

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

export function nearestTrailDistanceMeters(point: Position, networkEdges: TrailEdge[]): number {
  let nearestDistance = Infinity
  for (const edge of networkEdges) {
    nearestDistance = Math.min(nearestDistance, nearestPointOnEdge(point, edge, point[1]).distance)
  }
  return nearestDistance
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
  const attachmentsByWaypoint: Attachment[][] = waypoints.map((waypoint, waypointIndex) => {
    const candidates: Attachment[] = []
    networkEdges.forEach((edge, edgeIndex) => {
      const candidate = nearestPointOnEdge(waypoint, edge, latitudeReference)
      if (candidate.distance <= maxSnapDistanceMeters) candidates.push({ edgeIndex, ...candidate })
    })
    candidates.sort((a, b) => a.distance - b.distance)
    const nearest = candidates[0]
    if (!nearest) {
      const nearestDistance = networkEdges.reduce((distance, edge) => Math.min(
        distance,
        nearestPointOnEdge(waypoint, edge, latitudeReference).distance,
      ), Infinity)
      throw new SnapRouteError(`Point ${waypointIndex + 1} of ${waypoints.length} is ${Math.round(nearestDistance)} m from the nearest routable Chaska trail, beyond your ${maxSnapDistanceMeters} m limit. Move that point closer or increase the match limit.`, waypointIndex)
    }
    const margin = Math.min(CANDIDATE_DISTANCE_MARGIN_METERS, Math.max(5, nearest.distance * 0.2))
    const choices: Attachment[] = []
    for (const candidate of candidates) {
      if (candidate.distance > nearest.distance + margin) break
      const isDuplicate = choices.some(choice => distanceMeters(choice.coordinate, candidate.coordinate) <= 3)
      if (!isDuplicate) choices.push(candidate)
      if (choices.length === MAX_CANDIDATES_PER_WAYPOINT) break
    }
    return choices
  })

  const cutsByEdge = new Map<number, Cut[]>()
  networkEdges.forEach((edge, edgeIndex) => cutsByEdge.set(edgeIndex, [
    { t: 0, coordinate: edge.a },
    { t: 1, coordinate: edge.b },
  ]))
  attachmentsByWaypoint.forEach((attachments) => {
    attachments.forEach((attachment) => {
      const cuts = cutsByEdge.get(attachment.edgeIndex)!
      const existing = cuts.find(cut => Math.abs(cut.t - attachment.t) < 0.00001)
      if (!existing) cuts.push({ t: attachment.t, coordinate: attachment.coordinate })
    })
  })

  const registry = new NodeRegistry()
  const nodes = registry.all
  const candidateNodes = attachmentsByWaypoint.map(attachments => attachments.map(() => -1))
  for (const [edgeIndex, cuts] of cutsByEdge) {
    const edge = networkEdges[edgeIndex]!
    cuts.sort((a, b) => a.t - b.t)
    const nodeIds = cuts.map((cut) => {
      const nodeId = registry.get(cut.coordinate, latitudeReference)
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

  attachmentsByWaypoint.forEach((attachments, waypointIndex) => {
    attachments.forEach((attachment, candidateIndex) => {
      candidateNodes[waypointIndex]![candidateIndex] = registry.get(attachment.coordinate, latitudeReference)
    })
  })

  if (candidateNodes.some(candidates => candidates.some(node => node < 0))) throw new Error('Could not connect each point to the trail network.')

  // Keep a globally consistent choice across all sketch points. This avoids an
  // individually closest point pulling one leg onto a nearby but unintended path.
  const costs: number[][] = attachmentsByWaypoint.map(attachments => attachments.map(() => Infinity))
  const previousCandidates: number[][] = attachmentsByWaypoint.map(attachments => attachments.map(() => -1))
  const previousLegs: Array<Array<GraphEdge[] | null>> = attachmentsByWaypoint.map(attachments => attachments.map(() => null))
  attachmentsByWaypoint[0]!.forEach((attachment, index) => {
    costs[0]![index] = attachment.distance * SNAP_OFFSET_WEIGHT
  })

  for (let waypointIndex = 1; waypointIndex < attachmentsByWaypoint.length; waypointIndex++) {
    const drawnDistance = distanceMeters(waypoints[waypointIndex - 1]!, waypoints[waypointIndex]!)
    attachmentsByWaypoint[waypointIndex]!.forEach((targetAttachment, targetIndex) => {
      attachmentsByWaypoint[waypointIndex - 1]!.forEach((_, sourceIndex) => {
        const sourceCost = costs[waypointIndex - 1]![sourceIndex]!
        if (!Number.isFinite(sourceCost)) return
        const sourceNode = candidateNodes[waypointIndex - 1]![sourceIndex]!
        const targetNode = candidateNodes[waypointIndex]![targetIndex]!
        const leg = shortestPath(nodes, sourceNode, targetNode)
        if (!leg) return
        const legMeters = leg.reduce((sum, edge) => sum + edge.meters, 0)
        const collapsedDistance = Math.max(0, drawnDistance - legMeters)
        const candidateCost = sourceCost
          + legMeters
          + targetAttachment.distance * SNAP_OFFSET_WEIGHT
          + collapsedDistance * COLLAPSED_LEG_PENALTY
        if (candidateCost >= costs[waypointIndex]![targetIndex]!) return
        costs[waypointIndex]![targetIndex] = candidateCost
        previousCandidates[waypointIndex]![targetIndex] = sourceIndex
        previousLegs[waypointIndex]![targetIndex] = leg
      })
    })
  }

  const lastWaypointIndex = waypoints.length - 1
  let selectedCandidate = costs[lastWaypointIndex]!.indexOf(Math.min(...costs[lastWaypointIndex]!))
  if (selectedCandidate < 0 || !Number.isFinite(costs[lastWaypointIndex]![selectedCandidate]!)) {
    throw new Error(`The snapped points are not connected by the mapped trail network.`)
  }
  const selectedCandidates = new Array<number>(waypoints.length)
  const selectedLegs = new Array<GraphEdge[]>(Math.max(0, waypoints.length - 1))
  for (let waypointIndex = lastWaypointIndex; waypointIndex >= 0; waypointIndex--) {
    selectedCandidates[waypointIndex] = selectedCandidate
    if (waypointIndex > 0) {
      selectedLegs[waypointIndex - 1] = previousLegs[waypointIndex]![selectedCandidate] || []
      selectedCandidate = previousCandidates[waypointIndex]![selectedCandidate]!
      if (selectedCandidate < 0) throw new Error('Could not trace the best connected path through the mapped trails.')
    }
  }
  const path = selectedLegs.flat()
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
    snappedPoints: selectedCandidates.map((candidateIndex, waypointIndex) => attachmentsByWaypoint[waypointIndex]![candidateIndex]!.coordinate),
    routeMeters,
    maxOffsetMeters: Math.max(...selectedCandidates.map((candidateIndex, waypointIndex) => attachmentsByWaypoint[waypointIndex]![candidateIndex]!.distance)),
  }
}
