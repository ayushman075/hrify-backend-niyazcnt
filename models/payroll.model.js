import mongoose from 'mongoose';

const payrollSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  period: {
    type: String,
    required: true // 'YYYY-MM' for monthly, 'WWYY' for weekly
  },
  month: {
    type: String, // Kept optional, useful for filtering monthly payrolls specifically
  },
  type: {
    type: String,
    enum: ['Monthly', 'Weekly'],
    required: true
  },
  attendance: {
    workingDays: Number,
    presentDays: Number,
    paidLeaveDays: Number,
    unpaidLeave: Number,
    absent: Number,
    holidays: Number,
    lossOfPay: Number, // <-- Added Loss of Pay field
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
  employerContributions: {
    epf: Number,
    esi: Number,
  },
  netSalary: Number,
  status: {
    type: String,
    enum: ['draft', 'processed', 'paid'],
    default: 'draft'
  },
  processedAt: Date,
  paidAt: Date,
  comments: String
}, {
  timestamps: true
});

// Compound index updated to use `period` to support both weekly and monthly safely
payrollSchema.index({ employee: 1, period: 1 }, { unique: true });

export const Payroll = mongoose.model('Payroll', payrollSchema);