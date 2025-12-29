import mongoose from 'mongoose';

const advancePaymentConfigSchema = new mongoose.Schema({
  maxAdvancePercentage: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  allowWorkingDaysOnly: {
    type: Boolean,
    default: false
  },
  isEnabled: {
    type: Boolean,
    default: true
  },
  minServiceMonths: {
    type: Number,
    default: 3
  },
  maxAdvanceFrequency: {
    type: Number,
    default: 1 
  },
}, {
  timestamps: true
});

export const AdvancePaymentConfig = mongoose.model('AdvancePaymentConfig', advancePaymentConfigSchema);