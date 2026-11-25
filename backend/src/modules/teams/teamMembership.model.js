import mongoose from 'mongoose';

export const TEAM_ROLES = Object.freeze({
  TEAM_LEADER: 'TEAM_LEADER',
  TEAM_MEMBER: 'TEAM_MEMBER'
});

const teamMembershipSchema = new mongoose.Schema(
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
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    teamRole: {
      type: String,
      enum: Object.values(TEAM_ROLES),
      required: true
    },
    isReady: {
      type: Boolean,
      default: false,
      required: true
    },
    readyAt: {
      type: Date,
      default: null
    },
    joinedAt: {
      type: Date,
      default: Date.now,
      required: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// Prevent any user from joining multiple teams in the same competition.
teamMembershipSchema.index({ competitionId: 1, userId: 1 }, { unique: true });

// Prevent multiple TEAM_LEADER memberships inside the same team.
teamMembershipSchema.index(
  { teamId: 1, teamRole: 1 },
  {
    unique: true,
    partialFilterExpression: {
      teamRole: TEAM_ROLES.TEAM_LEADER
    }
  }
);

teamMembershipSchema.index({ teamId: 1, joinedAt: 1, _id: 1 });

export const TeamMembership =
  mongoose.models.TeamMembership ||
  mongoose.model('TeamMembership', teamMembershipSchema, 'team_memberships');
