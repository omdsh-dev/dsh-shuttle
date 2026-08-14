import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const output = fileURLToPath(new URL('../lib/', import.meta.url))
let entries
try {
  entries = await readdir(output, { withFileTypes: true })
} catch (error) {
  if (error?.code === 'ENOENT') process.exit(0)
  throw error
}

for (const entry of entries) {
  if (!entry.isFile() || (!entry.name.endsWith('.js') && !entry.name.endsWith('.js.map'))) continue
  await rm(join(output, entry.name))
}
