import mongoose from 'mongoose';

const frozenRosterEntrySchema = new mongoose.Schema(
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
    teamName: {
      type: String,
      required: true,
      trim: true
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
    round1RankedTeamCount: {
      type: Number,
      required: true,
      min: 1
    },
    headStartDistance: {
      type: Number,
      required: true,
      min: 0
    },
    rosterVersion: {
      type: Number,
      required: true,
      min: 0
    },
    lockedAt: {
      type: Date,
      required: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

frozenRosterEntrySchema.index({ competitionId: 1, teamId: 1 }, { unique: true });
frozenRosterEntrySchema.index({ competitionId: 1, frozenMemberIds: 1 });

export const FrozenRosterEntry =
  mongoose.models.FrozenRosterEntry ||
  mongoose.model('FrozenRosterEntry', frozenRosterEntrySchema, 'frozen_roster_entries');
