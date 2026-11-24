/** Bidirectional conversation migration plugin for DeepSeek Harness. */

export const name = 'shuttle'
export const inject = ['sessionPersistence']

export { Config } from './config.ts'
export type { Config as ShuttleConfig, ResolvedConfig } from './config.ts'
export { apply, ShuttleService } from './runtime.ts'
export { adapters, parseConversation, serializeConversation } from './adapters.ts'
export { fromDsh, toDsh, dshSessionId, materializeTextHistory, projectCompleteTurns, materializeCompleteTurns } from './dsh.ts'
export { executeShuttleCommand, parseShuttleInput, registerShuttleCommand } from './command.ts'
export { parseAhp, serializeAhp, toAhp, nativeAhpHistory, projectAhpHistory, readAhpArchive } from './ahp.ts'
export type { DshTextHistoryItem, DshTextHistoryOptions, CompleteHistoryTurn } from './dsh.ts'
export type * from './types.ts'
