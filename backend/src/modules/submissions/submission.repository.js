import { ExecutionJob } from '../execution/executionJob.model.js';
import { TEST_CASE_TYPES } from '../problems/testCase.model.js';
import { ACTIVE_SUBMISSION_STATUSES } from './submission.constants.js';
import { Submission } from './submission.model.js';

export async function findSubmissionByIdempotency({
  competitionId,
  teamId,
  submittedByUserId,
  idempotencyKey,
  session
}) {
  const query = Submission.findOne({
    competitionId,
    teamId,
    submittedByUserId,
    idempotencyKey
  });
  if (session) {
    query.session(session);
  }
  return query.lean();
}

export async function findSubmissionById({ competitionId, submissionId, teamId, session }) {
  const filter = {
    _id: submissionId,
    ...(competitionId ? { competitionId } : {}),
    ...(teamId ? { teamId } : {})
  };
  const query = Submission.findOne(filter);
  if (session) {
    query.session(session);
  }
  return query.lean();
}

export async function countActiveQueuedSubmissions({ competitionId, session }) {
  const query = Submission.countDocuments({
    ...(competitionId ? { competitionId } : {}),
    status: { $in: ACTIVE_SUBMISSION_STATUSES }
  });
  if (session) {
    query.session(session);
  }
  return query;
}

export async function listTeamSubmissions({
  competitionId,
  teamId,
  limit = 25,
  session
}) {
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const query = Submission.find({ competitionId, teamId })
    .sort({ admittedAt: -1, _id: -1 })
    .limit(boundedLimit);
  if (session) {
    query.session(session);
  }
  return query.lean();
}

/**
 * Retrieve SAMPLE job snapshots strictly for RUN serialization.
 */
export async function findRunSampleJobsForSubmission({ submissionId, session }) {
  const query = ExecutionJob.find({
    submissionId,
    testCaseType: TEST_CASE_TYPES.SAMPLE
  })
    .select('+testCaseInput +expectedOutput +actualOutputSnapshot +stderrSnapshot +compileOutputSnapshot')
    .sort({ testCaseOrder: 1 });
  if (session) {
    query.session(session);
  }
  return query.lean();
}
