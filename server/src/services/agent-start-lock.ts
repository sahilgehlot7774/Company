import { logger } from "../middleware/logger.js";

const START_LOCK_STALE_MS = 30_000;

type StartLock = { promise: Promise<void>; startedAtMs: number };

const startLocksByAgent = new Map<string, StartLock>();

/**
 * Process-wide admission lock around the queued-run start decision. The
 * per-agent lock only serialises one agent against itself, so two agents
 * promoted in the same heartbeat tick could each read the same free fleet slot
 * and both claim it. This lock makes "count running runs -> claim queued runs"
 * atomic across agents, which is what bounds the fan-out.
 */
let fleetRunAdmissionLock: StartLock | null = null;

async function waitForStartLock(
  lock: StartLock,
  logFields: Record<string, unknown>,
  staleMessage: string,
  timeoutMessage: string,
) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ ...logFields, staleMs: elapsedMs }, staleMessage);
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ ...logFields, staleMs: START_LOCK_STALE_MS }, timeoutMessage);
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous
    ? waitForStartLock(
        previous,
        { agentId },
        "agent start lock stale; continuing queued-run start",
        "agent start lock timed out; continuing queued-run start",
      )
    : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

/**
 * Wait for a lock holder to finish. Unlike the per-agent stale guard, this
 * never releases the lock early: the fleet ceiling must stay exclusive until
 * the holder's "count running -> claim" finishes, otherwise two waiters can
 * read the same free slot and both claim it. The stored promise is the holder's
 * settled marker, so a normal holder always resolves it; a long hold is logged
 * for visibility but the waiter still waits.
 */
async function awaitLockOwner(
  lock: StartLock,
  logFields: Record<string, unknown>,
  slowMessage: string,
) {
  const heldMs = Date.now() - lock.startedAtMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const warnSlow = () =>
    logger.warn({ ...logFields, heldMs: Date.now() - lock.startedAtMs }, slowMessage);
  if (heldMs >= START_LOCK_STALE_MS) {
    warnSlow();
  } else {
    timer = setTimeout(warnSlow, START_LOCK_STALE_MS - heldMs);
    timer.unref?.();
  }
  try {
    await lock.promise;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withFleetRunAdmissionLock<T>(fn: () => Promise<T>) {
  const previous = fleetRunAdmissionLock;
  const waitForPrevious = previous
    ? awaitLockOwner(
        previous,
        { lockScope: "fleet-run-admission" },
        "fleet run admission lock held longer than expected; waiting for the holder to finish",
      )
    : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  fleetRunAdmissionLock = { promise: marker, startedAtMs: Date.now() };
  try {
    return await run;
  } finally {
    if (fleetRunAdmissionLock?.promise === marker) {
      fleetRunAdmissionLock = null;
    }
  }
}
