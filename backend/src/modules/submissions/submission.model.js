import mongoose from 'mongoose';
import { LANGUAGE_KEYS } from '../problems/language.config.js';
import {
  SUBMISSION_MODES,
  SUBMISSION_SETTLEMENT_STATUSES,
  SUBMISSION_STATUSES,
  SUBMISSION_VERDICTS
} from './submission.constants.js';

const submissionSchema = new mongoose.Schema(
  {
    competitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Competition',
      required: true
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true
    },
    submittedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    challengeAttemptId: {
      type: mongoose.Schema.Types.ObjectId,
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
    sourceCode: {
      type: String,
      required: true,
      select: false
    },
    sourceCodeBytes: {
      type: Number,
      required: true,
      min: 1
    },
    sourceCodeHash: {
      type: String,
      required: true
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      minlength: 4,
      maxlength: 128
    },
    requestFingerprint: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: Object.values(SUBMISSION_STATUSES),
      default: SUBMISSION_STATUSES.QUEUED,
      required: true
    },
    verdict: {
      type: String,
      enum: [...Object.values(SUBMISSION_VERDICTS), null],
      default: null
    },
    totalCaseCount: {
      type: Number,
      required: true,
      min: 1
    },
    completedCaseCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    passedCaseCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    failedCaseCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    skippedCaseCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    executionJobsCreated: {
      type: Number,
      required: true,
      min: 1
    },
    executionJobsDispatched: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    admittedAt: {
      type: Date,
      required: true
    },
    competitionEndsAt: {
      type: Date,
      required: true
    },
    lastDispatchedAt: {
      type: Date,
      default: null
    },
    processingStartedAt: {
      type: Date,
      default: null
    },
    executionCompletedAt: {
      type: Date,
      default: null
    },
    settlementStatus: {
      type: String,
      enum: Object.values(SUBMISSION_SETTLEMENT_STATUSES),
      default: SUBMISSION_SETTLEMENT_STATUSES.NOT_READY,
      required: true
    },
    settledAt: {
      type: Date,
      default: null
    },
    settlementVersion: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    compileOutput: {
      type: String,
      default: ''
    },
    maxTimeSeconds: {
      type: Number,
      default: null
    },
    maxMemoryKb: {
      type: Number,
      default: null
    },
    systemErrorCode: {
      type: String,
      default: null
    },
    systemErrorMessage: {
      type: String,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// Scoped idempotency: unique per (competition, team, submitting user, idempotencyKey)
submissionSchema.index(
  { competitionId: 1, teamId: 1, submittedByUserId: 1, idempotencyKey: 1 },
  { unique: true }
);
// Team submission history
submissionSchema.index({ competitionId: 1, teamId: 1, admittedAt: -1, _id: -1 });
// Fair queue ordering & active competition submission scans (bounded to active teams)
submissionSchema.index({
  competitionId: 1,
  status: 1,
  lastDispatchedAt: 1,
  admittedAt: 1,
  _id: 1
});
// Challenge attempt history
submissionSchema.index({ competitionId: 1, challengeAttemptId: 1, admittedAt: -1 });
// Pending settlement monitoring
submissionSchema.index({ competitionId: 1, settlementStatus: 1, executionCompletedAt: 1 });
// General status monitoring (no TTL automatic deletion)
submissionSchema.index({ status: 1, admittedAt: 1 });

export const Submission =
  mongoose.models.Submission ||
  mongoose.model('Submission', submissionSchema, 'submissions');
