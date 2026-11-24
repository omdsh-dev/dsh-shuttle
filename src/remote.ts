import { z } from 'zod'
import { EXTERNAL_PLATFORMS } from './types.ts'
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  MigrationReport,
  ShuttleExportRequest,
  ShuttleImportRequest,
} from './types.ts'

const platformSchema = z.enum(EXTERNAL_PLATFORMS)
const optionalPathSchema = z.string().optional()

const importRequestSchema = z.object({
  from: platformSchema,
  source: optionalPathSchema,
  targetCwd: optionalPathSchema,
  apply: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
})

const exportRequestSchema = z.object({
  to: platformSchema,
  sessionIds: z.array(z.string()).optional(),
  destination: optionalPathSchema,
  apply: z.boolean().optional(),
})

const migrationReportSchema = z.object({
  dryRun: z.boolean(),
  startedAt: z.number(),
  finishedAt: z.number(),
  items: z.array(z.object({
    sourceId: z.string(),
    source: z.union([platformSchema, z.literal('dsh')]),
    target: z.union([platformSchema, z.literal('dsh')]),
    status: z.enum(['planned', 'written', 'skipped', 'failed']),
    destination: z.string().optional(),
    messageCount: z.number(),
    warning: z.string().optional(),
  })),
  warnings: z.array(z.string()),
})

/** Shared strict descriptors consumed by the Host registry and the browser Remote client. */
export const SHUTTLE_REMOTE_DESCRIPTORS = [
  {
    id: '@deepseek-ai/dsh-shuttle#shuttle/import',
    service: 'shuttle',
    namespace: 'shuttle',
    method: 'import',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-shuttle#ShuttleImportRequest',
        create: () => importRequestSchema,
      },
    }],
    cancellation: { parameter: 'signal' },
    result: {
      mode: 'strict',
      typeSymbol: '@deepseek-ai/dsh-shuttle#MigrationReport',
      create: () => migrationReportSchema,
    },
  },
  {
    id: '@deepseek-ai/dsh-shuttle#shuttle/export',
    service: 'shuttle',
    namespace: 'shuttle',
    method: 'export',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-shuttle#ShuttleExportRequest',
        create: () => exportRequestSchema,
      },
    }],
    cancellation: { parameter: 'signal' },
    result: {
      mode: 'strict',
      typeSymbol: '@deepseek-ai/dsh-shuttle#MigrationReport',
      create: () => migrationReportSchema,
    },
  },
] as const satisfies readonly InvocationDescriptor[]

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$73687574746c65 {
    import: (request: ShuttleImportRequest, signal?: AbortSignal) => Promise<RemoteResult<MigrationReport>>
    export: (request: ShuttleExportRequest, signal?: AbortSignal) => Promise<RemoteResult<MigrationReport>>
  }

  interface TypertRemoteMap {
    'shuttle/import': TypertRemoteNamespace$73687574746c65['import']
    'shuttle/export': TypertRemoteNamespace$73687574746c65['export']
  }

  interface TypertRemoteNamespaceMap {
    shuttle: TypertRemoteNamespace$73687574746c65
  }
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-shuttle',
  descriptors: SHUTTLE_REMOTE_DESCRIPTORS,
}

export default TYPERT_REMOTE
