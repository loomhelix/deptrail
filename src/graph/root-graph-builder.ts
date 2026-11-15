import {
  IMPORTER_PREFIX,
  PLACEHOLDER_PREFIX,
  type Edge,
  type Importer,
  type Manager,
  type NodeId,
  type PackageNode,
  type RootGraph,
  type SourceKind,
} from '../model.ts'

type RootGraphInit = { id: string; path: string; manager: Manager; source: SourceKind }
type GraphNode = Importer | PackageNode

export class RootGraphBuilder {
  private readonly init: RootGraphInit
  private readonly internTable = new Map<string, string>()
  private readonly importers = new Map<NodeId, Importer>()
  private readonly packages = new Map<NodeId, PackageNode>()
  private readonly warnings: string[] = []

  constructor(init: RootGraphInit) {
    this.init = init
  }

  intern(value: string): string {
    const stored = this.internTable.get(value)
    if (stored !== undefined) return stored
    this.internTable.set(value, value)
    return value
  }

  addImporter(path: string, name: string): NodeId {
    const id = IMPORTER_PREFIX + path
    if (!this.importers.has(id)) {
      this.importers.set(id, { id, path, name: this.intern(name), deps: [], dependents: [] })
    }
    return id
  }

  addPackage(id: NodeId, name: string, version: string, peerSuffix?: string): void {
    if (this.hasNode(id)) return
    const internedId = this.intern(id)
    const node: PackageNode = {
      id: internedId,
      name: this.intern(name),
      version: this.intern(version),
      deps: [],
      dependents: [],
    }
    if (peerSuffix !== undefined) node.peerSuffix = this.intern(peerSuffix)
    this.packages.set(internedId, node)
  }

  markNonRegistry(id: NodeId): void {
    const node = this.packages.get(id)
    if (node) node.nonRegistry = true
  }

  hasNode(id: NodeId): boolean {
    return this.importers.has(id) || this.packages.has(id)
  }

  addEdge(from: NodeId, edge: Edge): void {
    const source = this.findNode(from)
    if (!source) throw new Error(`Cannot add an edge from unknown node ${from}`)
    const alreadyPresent = source.deps.some((existing) => existing.to === edge.to && existing.kind === edge.kind)
    if (alreadyPresent) return
    source.deps.push({ to: this.intern(edge.to), kind: edge.kind, range: this.intern(edge.range) })
  }

  warn(message: string): void {
    this.warnings.push(message)
  }

  build(): RootGraph {
    this.resolveMissingTargets()
    this.rebuildDependents()
    return {
      id: this.init.id,
      path: this.init.path,
      manager: this.init.manager,
      source: this.init.source,
      status: 'ready',
      importers: [...this.importers.values()],
      packages: this.packages,
      warnings: [...this.warnings],
    }
  }

  private findNode(id: NodeId): GraphNode | undefined {
    return this.importers.get(id) ?? this.packages.get(id)
  }

  private allNodes(): GraphNode[] {
    return [...this.importers.values(), ...this.packages.values()]
  }

  private resolveMissingTargets(): void {
    for (const node of this.allNodes()) {
      for (const edge of node.deps) {
        if (this.hasNode(edge.to)) continue
        edge.to = this.addPlaceholder(edge.to)
      }
    }
  }

  private addPlaceholder(missingTarget: NodeId): NodeId {
    const id = this.intern(PLACEHOLDER_PREFIX + missingTarget)
    if (this.packages.has(id)) return id
    this.packages.set(id, { id, name: this.intern('?'), version: this.intern(''), deps: [], dependents: [] })
    this.warn(`Unresolved dependency ${missingTarget}`)
    return id
  }

  private rebuildDependents(): void {
    const nodes = this.allNodes()
    for (const node of nodes) node.dependents = []
    for (const parent of nodes) {
      for (const edge of parent.deps) this.appendDependent(edge.to, parent.id)
    }
  }

  private appendDependent(targetId: NodeId, parentId: NodeId): void {
    const target = this.findNode(targetId)
    if (!target) return
    const lastParent = target.dependents[target.dependents.length - 1]
    if (lastParent !== parentId) target.dependents.push(parentId)
  }
}
