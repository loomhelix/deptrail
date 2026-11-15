import type { RootGraphBuilder } from '../graph/root-graph-builder.ts'
import type { RootDescriptor } from '../model.ts'
import type { FileReader } from '../sources/file-reader.ts'
import { IMPORTER_BLOCKS, declaredDependencies, importerKeyOf, isNonRegistrySpec, readManifest } from './package-manifest.ts'

export async function buildManifestOnly(reader: FileReader, root: RootDescriptor, builder: RootGraphBuilder): Promise<void> {
  for (const importerPath of root.importerPaths) {
    const importerKey = importerKeyOf(root, importerPath)
    const read = await readManifest(reader, importerPath)
    if ('problem' in read) {
      builder.warn(read.problem)
      builder.addImporter(importerKey, importerKey)
      continue
    }
    const importerId = builder.addImporter(importerKey, read.manifest.name ?? importerKey)
    for (const { name, range, kind } of declaredDependencies(read.manifest, IMPORTER_BLOCKS)) {
      const packageId = `${name}@${range}`
      builder.addPackage(packageId, name, range)
      if (isNonRegistrySpec(range)) builder.markNonRegistry(packageId)
      builder.addEdge(importerId, { to: packageId, kind, range })
    }
  }
}
