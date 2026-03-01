import mongoose from "mongoose";

const overtimeSchema = new mongoose.Schema({
  employeeId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Employee', 
    required: true 
  },
  attendanceId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Attendance',
    required: true
  },
  date: { 
    type: Date, 
    required: true 
  },
  month: { 
    type: String, 
    required: true 
  },
  week: { 
    type: String, 
    required: true,
    trim: true,
    match: [/^\d{4}$/, 'Week must be in WWYY format (e.g., 0225)'] 
  },
  overtimeHours: { 
    type: Number, 
    required: true 
  },
  overtimePercentage: { 
    type: Number, 
    required: true 
  },
  earnedCredit: {
    type: Number, // Stores mathematical value: 0.25, 0.5, 0.75, or 1.0
    required: true
  },
  earnedCreditLabel: {
    type: String,
    enum: ['1/4 Day', 'Half Day', '3/4 Day', 'Full Day'],
    required: true
  },
  status: {
    type: String,
    enum: ['Pending', 'Redeemed_Paid', 'Redeemed_Leave', 'Rejected'],
    default: 'Pending'
  },
  redeemedAt: {
    type: Date
  },
  redeemedNotes: {
    type: String
  }
}, { timestamps: true });

export const Overtime = mongoose.model("Overtime", overtimeSchema);