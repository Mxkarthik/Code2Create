import mongoose from 'mongoose';

export const TEAM_STATUSES = Object.freeze({
  FORMING: 'FORMING',
  FORMED: 'FORMED',
  READY: 'READY',
  DISSOLVED: 'DISSOLVED'
});

export const ACTIVE_TEAM_STATUSES = Object.freeze([
  TEAM_STATUSES.FORMING,
  TEAM_STATUSES.FORMED,
  TEAM_STATUSES.READY
]);

export const RANK_MAPPING_STATUSES = Object.freeze({
  UNMAPPED: 'UNMAPPED',
  MAPPED: 'MAPPED',
  STALE: 'STALE'
});

const teamSchema = new mongoose.Schema(
  {
    competitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Competition',
      required: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 40
    },
    normalizedName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    joinCode: {
      type: String,
      default: null,
      trim: true,
      uppercase: true
    },
    leaderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    memberCount: {
      type: Number,
      required: true,
      min: 0,
      default: 1
    },
    readyMemberCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    status: {
      type: String,
      enum: Object.values(TEAM_STATUSES),
      default: TEAM_STATUSES.FORMING,
      required: true
    },
    revision: {
      type: Number,
      required: true,
      min: 0,
      default: 1
    },
    createRequestKey: {
      type: String,
      default: null
    },
    dissolvedAt: {
      type: Date,
      default: null
    },
    round1Rank: {
      type: Number,
      min: 1,
      default: null
    },
    round1RankedTeamCount: {
      type: Number,
      min: 1,
      default: null
    },
    round1RankImportVersion: {
      type: Number,
      min: 0,
      default: null
    },
    round1MappingStatus: {
      type: String,
      enum: Object.values(RANK_MAPPING_STATUSES),
      default: RANK_MAPPING_STATUSES.UNMAPPED,
      required: true
    },
    isExcluded: {
      type: Boolean,
      default: false,
      required: true
    },
    excludedAt: {
      type: Date,
      default: null
    },
    excludedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    exclusionReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null
    },
    frozenHeadStartDistance: {
      type: Number,
      min: 0,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

teamSchema.index(
  { competitionId: 1, normalizedName: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ACTIVE_TEAM_STATUSES }
    }
  }
);

teamSchema.index(
  { competitionId: 1, joinCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      joinCode: { $type: 'string' }
    }
  }
);

teamSchema.index(
  { competitionId: 1, leaderId: 1, createRequestKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      createRequestKey: { $type: 'string' },
      status: { $in: ACTIVE_TEAM_STATUSES }
    }
  }
);

teamSchema.index({ competitionId: 1, status: 1 });

export const Team = mongoose.models.Team || mongoose.model('Team', teamSchema);
