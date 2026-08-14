import z from '@deepseek-ai/schemastery'
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_SESSIONS } from './io.ts'

export interface Config {
  /** Maximum bytes read from one external session artifact. */
  maxFileBytes?: number
  /** Maximum artifacts considered by one import. */
  maxSessions?: number
}

export interface ResolvedConfig {
  maxFileBytes: number
  maxSessions: number
}

export const Config: z<Config> = z.object({
  maxFileBytes: z.number().step(1).min(1).max(1024 * 1024 * 1024).default(DEFAULT_MAX_FILE_BYTES),
  maxSessions: z.number().step(1).min(1).max(100_000).default(DEFAULT_MAX_SESSIONS),
})

export function resolveConfig(config: Config = {}): ResolvedConfig {
  return Config(config) as ResolvedConfig
}
