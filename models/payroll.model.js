import mongoose from 'mongoose';

const payrollSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  month: {
    type: String,
    required: true
  },
  attendance: {
    workingDays: Number,
    presentDays: Number,
    paidLeaveDays: Number,
    unpaidLeave: Number,
    absent: Number,
    holidays: Number,
    totalDaysPayable: Number,
    totalDaysNonPayable: Number,
    attendancePercentage: Number
  },
  earnings: {
    basicSalary: Number,
    houseRentAllowance: Number,
    dearnessAllowance: Number,
    perquisites: Number,
    others: Number,
    bonus: Number,
    variablePay: Number,
    grossSalary: Number
  },
  deductions: {
    epfEmployee: Number,
    esiEmployee: Number,
    taxes: Number,
    totalDeductions: Number
  },
  netSalary: Number,
  status: {
    type: String,
    enum: ['draft', 'processed', 'paid'],
    default: 'draft'
  },
  processedAt: Date,
  paidAt: Date
}, {
  timestamps: true
});

// Compound index for efficient queries
payrollSchema.index({ employee: 1, month: 1 }, { unique: true });

export const Payroll = mongoose.model('Payroll', payrollSchema);