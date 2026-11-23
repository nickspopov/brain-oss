// Core context: DB, configuration, clock, logger. The core takes time only from `now()`.
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import type { EventBus } from './events.js';
import type { OrientTracker } from './orient.js';
import type { RateLimiter } from './ratelimit.js';
import type { WaiterMap } from './waiters.js';

export type Clock = () => number;

/**
 * Grants version counter: any write to grants, groups, group_members, principals,
 * spaces increments it; the in-memory grants snapshot is rebuilt when the version does not match.
 */
export interface AclState {
  version: number;
}

export interface Core {
  db: Db;
  config: Config;
  now: Clock;
  log: Logger;
  tenantId: string;
  serverVersion: string;
  acl: AclState;
  /** Server key (data/secret.key): cursor encryption. */
  secretKey: Buffer;
  /** Request rate limits in process memory. */
  limiter: RateLimiter;
  /** Event bus after a write (commit step 12): webhooks, later push. */
  events: EventBus;
  /** Orientation state per token in memory: start_here, soft gate, AGENTS.md notes. */
  orient: OrientTracker;
  /** Parked waits for mail: GET /api/v1/inbox?wait and handoff_wait. */
  waiters: WaiterMap;
}

export type { Logger };
