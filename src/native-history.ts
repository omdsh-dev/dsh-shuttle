import { stat } from 'node:fs/promises'
import { adapters } from './adapters.ts'
import { toAhp, type AhpExport } from './ahp.ts'
import { readBoundedText } from './io.ts'
import type { ExternalPlatform } from './types.ts'

export async function readNativeArchives(
  platform: Exclude<ExternalPlatform, 'ahp'>, path: string, maxBytes: number,
): Promise<AhpExport[]> {
  const text = await readBoundedText(path, maxBytes)
  const now = Math.trunc((await stat(path)).mtimeMs)
  return adapters[platform].parse(text, { path, now }).map(toAhp)
}
