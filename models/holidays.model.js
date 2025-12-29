import mongoose from 'mongoose';

const holidaySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  date: {
    type: Date,
    required: true
  },
  month: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    required: true,
    enum: ['National', 'Regional', 'Company', 'Optional'],
    default: 'National'
  },
  isActive: {
    type: Boolean,
    default: true
  },
}, {
  timestamps: true
});

// Compound index for efficient queries
holidaySchema.index({ date: 1, type: 1 });


// Ensure unique holiday on same date
holidaySchema.index({ date: 1, name: 1 }, { unique: true });

export const Holiday = mongoose.model('Holiday', holidaySchema);