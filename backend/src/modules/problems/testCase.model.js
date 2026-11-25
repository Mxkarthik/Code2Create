import mongoose from 'mongoose';

export const TEST_CASE_TYPES = Object.freeze({
  SAMPLE: 'SAMPLE',
  HIDDEN: 'HIDDEN'
});

const testCaseSchema = new mongoose.Schema(
  {
    competitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Competition',
      required: true
    },
    problemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Problem',
      required: true
    },
    type: {
      type: String,
      enum: Object.values(TEST_CASE_TYPES),
      required: true
    },
    input: {
      type: String,
      default: '',
      validate: {
        validator: (v) => typeof v === 'string',
        message: 'input must be a string'
      }
    },
    expectedOutput: {
      type: String,
      default: '',
      validate: {
        validator: (v) => typeof v === 'string',
        message: 'expectedOutput must be a string'
      }
    },
    explanation: {
      type: String,
      default: null,
      maxlength: 2000
    },
    displayOrder: {
      type: Number,
      required: true,
      min: 1,
      max: 500
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

testCaseSchema.index({ problemId: 1, type: 1, displayOrder: 1 }, { unique: true });
testCaseSchema.index({ competitionId: 1, problemId: 1, type: 1, displayOrder: 1 });

export const TestCase =
  mongoose.models.TestCase || mongoose.model('TestCase', testCaseSchema, 'test_cases');
