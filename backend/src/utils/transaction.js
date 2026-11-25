import crypto from 'node:crypto';
import mongoose from 'mongoose';

const DEFAULT_MAX_TX_RETRIES = 5;

export function isTransientTransactionError(err) {
  if (!err) {
    return false;
  }
  if (typeof err.hasErrorLabel === 'function') {
    if (
      err.hasErrorLabel('TransientTransactionError') ||
      err.hasErrorLabel('UnknownTransactionCommitResult')
    ) {
      return true;
    }
  }
  if (Array.isArray(err.errorLabels)) {
    if (
      err.errorLabels.includes('TransientTransactionError') ||
      err.errorLabels.includes('UnknownTransactionCommitResult')
    ) {
      return true;
    }
  }
  return err.code === 112 || err.codeName === 'WriteConflict';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute multi-document mutations inside a MongoDB transaction with bounded
 * retries on transient WriteConflict errors. Never run parallel DB ops inside workFn.
 */
export async function runInTransaction(workFn, { maxRetries = DEFAULT_MAX_TX_RETRIES } = {}) {
  let attempt = 0;

  while (true) {
    attempt += 1;
    const session = await mongoose.startSession();

    try {
      let txResult;
      await session.withTransaction(async () => {
        txResult = await workFn(session);
      });
      return txResult;
    } catch (err) {
      if (isTransientTransactionError(err) && attempt < maxRetries) {
        const jitterMs = 15 + crypto.randomInt(0, 35) * attempt;
        await delay(jitterMs);
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}
