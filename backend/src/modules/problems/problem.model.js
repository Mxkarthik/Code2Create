import mongoose from 'mongoose';
import { LANGUAGE_KEYS, PROBLEM_DIFFICULTIES } from './language.config.js';

export const PROBLEM_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED: 'ARCHIVED'
});

const languageLimitSchema = new mongoose.Schema(
  {
    cpuTimeLimitSeconds: { type: Number, required: true, min: 1, max: 10 },
    wallTimeLimitSeconds: { type: Number, required: true, min: 1, max: 20 },
    memoryLimitKb: { type: Number, required: true, min: 16000, max: 512000 }
  },
  { _id: false }
);

const problemSchema = new mongoose.Schema(
  {
    competitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Competition',
      required: true
    },
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 120
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 80
    },
    difficulty: {
      type: String,
      enum: Object.values(PROBLEM_DIFFICULTIES),
      required: true
    },
    statement: {
      type: String,
      required: true,
      maxlength: 30000
    },
    inputFormat: {
      type: String,
      required: true,
      maxlength: 10000
    },
    outputFormat: {
      type: String,
      required: true,
      maxlength: 10000
    },
    constraints: {
      type: String,
      required: true,
      maxlength: 10000
    },
    allowedLanguages: {
      type: [String],
      enum: LANGUAGE_KEYS,
      required: true,
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length >= 1,
        message: 'At least one allowed programming language is required'
      }
    },
    executionLimits: {
      perLanguage: {
        type: Map,
        of: languageLimitSchema,
        required: true
      },
      maxSourceCodeBytes: {
        type: Number,
        required: true,
        default: 32768
      },
      maxOutputBytes: {
        type: Number,
        required: true,
        default: 262144
      },
      networkAccessEnabled: {
        type: Boolean,
        required: true,
        default: false
      },
      oneRunPerJob: {
        type: Boolean,
        required: true,
        default: true
      }
    },
    status: {
      type: String,
      enum: Object.values(PROBLEM_STATUSES),
      default: PROBLEM_STATUSES.DRAFT,
      required: true
    },
    displayOrder: {
      type: Number,
      required: true,
      min: 1,
      max: 500,
      default: 1
    },
    version: {
      type: Number,
      required: true,
      min: 1,
      default: 1
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    publishedAt: {
      type: Date,
      default: null
    },
    archivedAt: {
      type: Date,
      default: null
    },
    verification: {
      status: {
        type: String,
        enum: ['UNVERIFIED', 'VERIFIED'],
        default: 'UNVERIFIED',
        required: true
      },
      verifiedVersion: {
        type: Number,
        default: null
      },
      verifiedLanguage: {
        type: String,
        enum: [...LANGUAGE_KEYS, null],
        default: null
      },
      verifiedAt: {
        type: Date,
        default: null
      },
      verifiedCaseCount: {
        type: Number,
        default: 0,
        min: 0
      }
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

problemSchema.index({ competitionId: 1, slug: 1 }, { unique: true });
problemSchema.index({ competitionId: 1, status: 1, difficulty: 1, displayOrder: 1 });

export const Problem =
  mongoose.models.Problem || mongoose.model('Problem', problemSchema);
