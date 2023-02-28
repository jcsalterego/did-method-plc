import { CID } from 'multiformats/cid'
import { check, cidForCbor, HOUR } from '@atproto/common'
import * as t from './types'
import {
  assureValidCreationOp,
  assureValidOp,
  assureValidSig,
  normalizeOp,
} from './operations'
import {
  ImproperOperationError,
  LateRecoveryError,
  MisorderedOperationError,
} from './error'

export const assureValidNextOp = async (
  did: string,
  ops: t.IndexedOperation[],
  proposed: t.Operation,
): Promise<{ nullified: CID[]; prev: CID | null }> => {
  await assureValidOp(proposed)

  // special case if account creation
  if (ops.length === 0) {
    await assureValidCreationOp(did, proposed)
    return { nullified: [], prev: null }
  }

  const proposedPrev = proposed.prev ? CID.parse(proposed.prev) : undefined
  if (!proposedPrev) {
    throw new MisorderedOperationError()
  }

  const indexOfPrev = ops.findIndex((op) => proposedPrev.equals(op.cid))
  if (indexOfPrev < 0) {
    throw new MisorderedOperationError()
  }

  // if we are forking history, these are the ops still in the proposed canonical history
  const opsInHistory = ops.slice(0, indexOfPrev + 1)
  const nullified = ops.slice(indexOfPrev + 1)
  const lastOp = opsInHistory.at(-1)
  if (!lastOp) {
    throw new MisorderedOperationError()
  }
  const lastOpNormalized = normalizeOp(lastOp.operation)
  const firstNullified = nullified[0]

  // if this does not involve nullification
  if (!firstNullified) {
    await assureValidSig(lastOpNormalized.rotationKeys, proposed)
    return { nullified: [], prev: proposedPrev }
  }

  const disputedSigner = await assureValidSig(
    lastOpNormalized.rotationKeys,
    firstNullified.operation,
  )

  const indexOfSigner = lastOpNormalized.rotationKeys.indexOf(disputedSigner)
  const morePowerfulKeys = lastOpNormalized.rotationKeys.slice(0, indexOfSigner)

  await assureValidSig(morePowerfulKeys, proposed)

  // recovery key gets a 72hr window to do historical re-wrties
  if (nullified.length > 0) {
    const RECOVERY_WINDOW = 72 * HOUR
    const timeLapsed = Date.now() - firstNullified.createdAt.getTime()
    if (timeLapsed > RECOVERY_WINDOW) {
      throw new LateRecoveryError(timeLapsed)
    }
  }

  return {
    nullified: nullified.map((op) => op.cid),
    prev: proposedPrev,
  }
}

export const validateOperationLog = async (
  did: string,
  ops: t.CompatibleOp[],
): Promise<t.DocumentData> => {
  // make sure they're all validly formatted operations
  const [first, ...rest] = ops
  if (!check.is(first, t.def.compatibleOp)) {
    throw new ImproperOperationError('incorrect structure', first)
  }
  for (const op of rest) {
    if (!check.is(op, t.def.operation)) {
      throw new ImproperOperationError('incorrect structure', op)
    }
  }

  // ensure the first op is a valid & signed create operation
  let doc = await assureValidCreationOp(did, first)
  let prev = await cidForCbor(first)

  for (const op of rest) {
    if (!op.prev || !CID.parse(op.prev).equals(prev)) {
      throw new MisorderedOperationError()
    }

    await assureValidSig(doc.rotationKeys, op)
    const { signingKey, rotationKeys, handles, services } = op
    doc = { did, signingKey, rotationKeys, handles, services }
    prev = await cidForCbor(op)
  }

  return doc
}