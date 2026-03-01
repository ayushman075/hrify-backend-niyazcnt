import mongoose from 'mongoose';

const payrollSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
    index: true
  },
  period: {
    type: String,
    required: true,
    index: true
  },
  month: {
    type: String, 
    index: true
  },
  type: {
    type: String,
    enum: ['Monthly', 'Weekly'],
    required: true
  },
  attendance: {
    totalDaysPresent: { type: Number, default: 0 },
    workingDays: { type: Number, default: 0 },
    weeklyOffAvailed: { type: Number, default: 0 },
    leaveDuringMonth: { type: Number, default: 0 },
    unpaidLeaves: { type: Number, default: 0 },
    holidays: { type: Number, default: 0 },
    absent: { type: Number, default: 0 },
  lateDaysEquivalent: { type: Number, default: 0 },
    lossOfPay: { type: Number, default: 0 }, 
    totalDaysPayable: { type: Number, default: 0 },
    totalDaysNonPayable: { type: Number, default: 0 },
    attendancePercentage: { type: Number, default: 0 },
    overtimeDays: { type: Number, default: 0 },
    overtimeCreditsEarned: { type: Number, default: 0 },
    overtimeEncashedCredits: { type: Number, default: 0 }
  },
  earnings: {
    basicSalary: { type: Number, default: 0 },
    houseRentAllowance: { type: Number, default: 0 },
    dearnessAllowance: { type: Number, default: 0 },
    perquisites: { type: Number, default: 0 },
    
    // Distributed Additional Pay
    bonus: { type: Number, default: 0 },
    variablePay: { type: Number, default: 0 },
    others: { type: Number, default: 0 },
    
    overtimePay: { type: Number, default: 0 },
    reimbursements: { type: Number, default: 0 }, // Approved Expenses
    grossSalary: { type: Number, default: 0 }
  },
  deductions: {
    epfEmployee: { type: Number, default: 0 },
    esiEmployee: { type: Number, default: 0 },
    taxes: { type: Number, default: 0 },
    advancePayments: { type: Number, default: 0 }, // Paid Advances
    lateFines: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 }
  },
  employerContributions: {
    epf: { type: Number, default: 0 },
    esi: { type: Number, default: 0 },
  },
  netSalary: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['draft', 'processed', 'paid'],
    default: 'draft',
    index: true
  },
  processedAt: Date,
  paidAt: Date,
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  comments: String
}, {
  timestamps: true
});

payrollSchema.index({ employee: 1, period: 1 }, { unique: true });

export const Payroll = mongoose.model('Payroll', payrollSchema);