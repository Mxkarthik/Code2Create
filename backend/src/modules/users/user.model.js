import mongoose from 'mongoose';

export const USER_ROLES = Object.freeze({
  PARTICIPANT: 'PARTICIPANT',
  ADMIN: 'ADMIN'
});

const userSchema = new mongoose.Schema(
  {
    googleSub: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    avatar: {
      type: String,
      default: null,
      trim: true
    },
    role: {
      type: String,
      enum: Object.values(USER_ROLES),
      default: USER_ROLES.PARTICIPANT,
      required: true
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true
    },
    lastLoginAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

userSchema.index({ email: 1 });
userSchema.index({ role: 1, isActive: 1 });

export const User = mongoose.models.User || mongoose.model('User', userSchema);
