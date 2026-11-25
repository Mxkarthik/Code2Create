import mongoose from 'mongoose';

export const COMPETITION_STATUSES = Object.freeze({
  LOBBY: 'LOBBY',
  LOCKED: 'LOCKED',
  LIVE: 'LIVE',
  SETTLING: 'SETTLING',
  COMPLETED: 'COMPLETED'
});

export const DEFAULT_COMPETITION_SLUG = 'code-rush-round-2';

const competitionSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true,
      default: DEFAULT_COMPETITION_SLUG
    },
    name: {
      type: String,
      required: true,
      trim: true,
      default: 'CODE RUSH'
    },
    status: {
      type: String,
      enum: Object.values(COMPETITION_STATUSES),
      default: COMPETITION_STATUSES.LOBBY,
      required: true
    },
    teamSize: {
      type: Number,
      required: true,
      min: 1,
      max: 10,
      default: 2
    },
    maxTeams: {
      type: Number,
      required: true,
      min: 1,
      max: 200,
      default: 50
    },
    activeTeamCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    rosterVersion: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    durationSeconds: {
      type: Number,
      required: true,
      min: 10,
      max: 14400,
      default: 1800
    },
    maxChallengeOpportunities: {
      type: Number,
      required: true,
      min: 1,
      max: 50,
      default: 6
    },
    maxHeadStart: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 20
    },
    qualificationLimit: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
      default: 10
    },
    round1RankedTeamCount: {
      type: Number,
      min: 1,
      default: null
    },
    rankImportVersion: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    rankImportConfirmedVersion: {
      type: Number,
      min: 0,
      default: null
    },
    rankImportConfirmedAt: {
      type: Date,
      default: null
    },
    rankImportConfirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    lockedAt: {
      type: Date,
      default: null
    },
    lockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    lockedRosterVersion: {
      type: Number,
      min: 0,
      default: null
    },
    eligibleTeamCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    startedAt: {
      type: Date,
      default: null
    },
    startedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    endsAt: {
      type: Date,
      default: null
    },
    settlingAt: {
      type: Date,
      default: null
    },
    completedAt: {
      type: Date,
      default: null
    },
    lifecycleVersion: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

competitionSchema.index({ status: 1, endsAt: 1 });

export const Competition =
  mongoose.models.Competition || mongoose.model('Competition', competitionSchema);
