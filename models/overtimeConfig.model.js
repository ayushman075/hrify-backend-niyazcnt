import mongoose from "mongoose";

const overtimeConfigSchema = new mongoose.Schema({
  configType: {
    type: String,
    enum: ['TIER_2', 'TIER_4'], // TIER_2 = Half/Full, TIER_4 = 1/4, Half, 3/4, Full
    required: true,
    default: 'TIER_2'
  },
  thresholds: {
    quarterDayPercentage: { type: Number, default: 25 },
    halfDayPercentage: { type: Number, default: 50 },
    threeQuarterDayPercentage: { type: Number, default: 75 },
    fullDayPercentage: { type: Number, default: 100 },
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

export const OvertimeConfig = mongoose.model("OvertimeConfig", overtimeConfigSchema);