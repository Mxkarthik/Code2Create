import mongoose from 'mongoose';
import { LANGUAGE_KEYS } from '../problems/language.config.js';
import { TEST_CASE_TYPES } from '../problems/testCase.model.js';
import {
  DEFAULT_EXECUTION_CAPACITY_KEY,
  EXECUTION_JOB_STATUSES,
  SUBMISSION_MODES,
  SUBMISSION_VERDICTS
} from '../submissions/submission.constants.js';

const executionLimitsSnapshotSchema = new mongoose.Schema(
  {
    cpuTimeLimitSeconds: { type: Number, required: true },
    wallTimeLimitSeconds: { type: Number, required: true },
    memoryLimitKb: { type: Number, required: true },
    maxSourceCodeBytes: { type: Number, required: true },
    maxOutputBytes: { type: Number, required: true }
  },
  { _id: false }
);

const executionJobSchema = new mongoose.Schema(
  {
    competitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Competition',
      required: true
    },
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Submission',
      required: true
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true
    },
    problemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Problem',
      required: true
    },
    problemVersion: {
      type: Number,
      required: true,
      min: 1
    },
    testCaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TestCase',
      required: true
    },
    testCaseOrder: {
      type: Number,
      required: true,
      min: 1
    },
    testCaseType: {
      type: String,
      enum: Object.values(TEST_CASE_TYPES),
      required: true
    },
    // Immutable test case snapshots captured at admission so edits cannot alter queued jobs.
    testCaseInput: {
      type: String,
      default: '',
      select: false
    },
    expectedOutput: {
      type: String,
      default: '',
      select: false
    },
    mode: {
      type: String,
      enum: Object.values(SUBMISSION_MODES),
      required: true
    },
    language: {
      type: String,
      enum: LANGUAGE_KEYS,
      required: true
    },
    judge0LanguageId: {
      type: Number,
      required: true
    },
    executionLimits: {
      type: executionLimitsSnapshotSchema,
      required: true
    },
    capacityKey: {
      type: String,
      required: true,
      default: DEFAULT_EXECUTION_CAPACITY_KEY
    },
    status: {
      type: String,
      enum: Object.values(EXECUTION_JOB_STATUSES),
      default: EXECUTION_JOB_STATUSES.QUEUED,
      required: true
    },
    judge0Token: {
      type: String,
      default: null,
      select: false
    },
    dispatchAttemptId: {
      type: String,
      default: null
    },
    dispatchStartedAt: {
      type: Date,
      default: null
    },
    uncertainSince: {
      type: Date,
      default: null
    },
    nextPollAt: {
      type: Date,
      default: null
    },
    lastPolledAt: {
      type: Date,
      default: null
    },
    leaseOwner: {
      type: String,
      default: null
    },
    leaseExpiresAt: {
      type: Date,
      default: null
    },
    fencingVersion: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    retryCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    resultVerdict: {
      type: String,
      enum: [...Object.values(SUBMISSION_VERDICTS), null],
      default: null
    },
    runtimeErrorSignal: {
      type: String,
      default: null
    },
    executionTime: {
      type: Number,
      default: null
    },
    wallTime: {
      type: Number,
      default: null
    },
    memoryUsage: {
      type: Number,
      default: null
    },
    // Populated ONLY for RUN SAMPLE diagnostics; strictly null for HIDDEN cases.
    actualOutputSnapshot: {
      type: String,
      default: null,
      select: false
    },
    stderrSnapshot: {
      type: String,
      default: null,
      select: false
    },
    compileOutputSnapshot: {
      type: String,
      default: '',
      select: false
    },
    outputTruncated: {
      type: Boolean,
      default: false
    },
    completedAt: {
      type: Date,
      default: null
    },
    sanitizedSystemError: {
      type: {
        code: { type: String, required: true },
        message: { type: String, required: true }
      },
      _id: false,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// Prevent duplicate logical test case jobs per submission
executionJobSchema.index({ submissionId: 1, testCaseOrder: 1 }, { unique: true });
executionJobSchema.index({ submissionId: 1, testCaseId: 1 }, { unique: true });
// Bounded polling & lease queries
executionJobSchema.index({ status: 1, nextPollAt: 1, leaseExpiresAt: 1, _id: 1 });
// Fair scheduling per team
executionJobSchema.index({ status: 1, teamId: 1, testCaseOrder: 1, _id: 1 });
// Recovery indexes
executionJobSchema.index({ status: 1, leaseExpiresAt: 1 });
executionJobSchema.index({ status: 1, uncertainSince: 1 });
executionJobSchema.index({ capacityKey: 1, status: 1 });

export const ExecutionJob =
  mongoose.models.ExecutionJob ||
  mongoose.model('ExecutionJob', executionJobSchema, 'execution_jobs');
