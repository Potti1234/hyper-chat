import { Clock, Effect } from 'effect'

import { demoData } from '@/app/seed'
import * as Store from '@/app/store'
import type { WorkspaceData } from '@/app/workspace'

/* The workspace for tests: in memory, with the demo content (no passwords
   unless a test adds them; hashing is slow). */

export const workspaceLayer = (data: Effect.Effect<WorkspaceData> = Effect.map(Clock.currentTimeMillis, demoData)) => Store.memoryLayer(data)
