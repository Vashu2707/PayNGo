import mongoose, { type ClientSession } from "mongoose";

/**
 * Runs `fn` inside a MongoDB multi-document transaction when the server
 * supports it (replica set / mongos). Standalone servers reject transactions
 * with "Transaction numbers are only allowed on a replica set member or mongos",
 * so on that specific error we re-run `fn` without a session exactly once and
 * remember that transactions are unavailable for the lifetime of the process.
 *
 * The fallback relies on the callers' idempotency guards (e.g. `paymentStatus:
 * { $ne: "success" }`, `stockHistory.txnId: { $ne }`) instead of atomicity.
 * Any non-transaction error thrown by `fn` is re-thrown as-is — it is never
 * re-executed, so business failures cannot duplicate side effects.
 */

const TX_UNSUPPORTED = /transaction numbers are only allowed|replica set|does not support transactions|mongos/i;

let transactionsSupported: boolean | null = null;

function isTransactionUnsupported(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: number })?.code;
  return code === 20 || TX_UNSUPPORTED.test(message);
}

export async function runWithOptionalTransaction<T>(
  fn: (session: ClientSession | undefined) => Promise<T>
): Promise<T> {
  if (transactionsSupported === false) {
    return fn(undefined);
  }

  let session: ClientSession;
  try {
    session = await mongoose.startSession();
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      transactionsSupported = false;
      return fn(undefined);
    }
    throw err;
  }

  try {
    const result = await session.withTransaction(() => fn(session));
    transactionsSupported = true;
    return result as T;
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      transactionsSupported = false;
      return fn(undefined);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

export function transactionsFeatureAvailable(): boolean {
  return transactionsSupported !== false;
}
