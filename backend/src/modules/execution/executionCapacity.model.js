import mongoose from 'mongoose';
import { DEFAULT_EXECUTION_CAPACITY_KEY } from '../submissions/submission.constants.js';

const executionCapacitySchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
      default: DEFAULT_EXECUTION_CAPACITY_KEY
    },
    maxInFlight: {
      type: Number,
      required: true,
      min: 1,
      max: 64,
      default: 8
    },
    activeJobIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: []
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

export const ExecutionCapacity =
  mongoose.models.ExecutionCapacity ||
  mongoose.model('ExecutionCapacity', executionCapacitySchema, 'execution_capacities');
