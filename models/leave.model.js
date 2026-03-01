import mongoose from 'mongoose';

const LeaveSchema = new mongoose.Schema({
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  leaveType: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LeaveConfig',
    required: true,
  },
  startDate: {
    type: Date,
    required: true,
  },
  endDate: {
    type: Date,
    required: true,
  },
  reason: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Disapproved'],
    default: 'Pending',
  },
  comments: {
    type: String,
  },
  appliedOn: {
    type: Date,
    default: Date.now,
  },
  approvedOrDisapprovedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
});

export const Leave = mongoose.model('Leave', LeaveSchema);
