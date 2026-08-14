import { SHUTTLE_REMOTE_DESCRIPTORS } from './remote.ts'

/** Host-side strict Remote manifest loaded with the Shuttle plugin. */
export const TYPERT = {
  package: '@deepseek-ai/dsh-shuttle',
  face: 'host',
  schemas: [],
  invocations: SHUTTLE_REMOTE_DESCRIPTORS,
  model: { services: [], events: [], objects: [] },
}
