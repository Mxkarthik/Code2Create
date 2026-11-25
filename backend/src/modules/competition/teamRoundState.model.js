import mongoose from 'mongoose';

const teamRoundStateSchema = new mongoose.Schema(
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
    frozenLeaderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    frozenMemberIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      required: true
    },
    round1Rank: {
      type: Number,
      required: true,
      min: 1
    },
    headStartDistance: {
      type: Number,
      required: true,
      min: 0
    },
    earnedDistance: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    totalDistance: {
      type: Number,
      required: true,
      min: 0
    },
    challengeOpportunitiesUsed: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    sampleRunsUsed: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    finalSubmissionsUsed: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    rejectedFinalSubmissions: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    activeChallengeAttemptId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    pendingSubmissionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    stateVersion: {
      type: Number,
      required: true,
      min: 1,
      default: 1
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

teamRoundStateSchema.index({ competitionId: 1, teamId: 1 }, { unique: true });

export const TeamRoundState =
  mongoose.models.TeamRoundState ||
  mongoose.model('TeamRoundState', teamRoundStateSchema, 'team_round_states');
