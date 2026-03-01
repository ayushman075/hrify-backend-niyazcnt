import mongoose from "mongoose";

const expenseItemSchema = new mongoose.Schema({
  category: {
    type: String,
    enum: [
      'Rent', 
      'Meals', 
      'Tea/Snacks', 
      'Travel/Transport', 
      'Accommodation', 
      'Office Supplies', 
      'Client Entertainment',
      'Other'
    ],
    required: [true, "Expense category is required"]
  },
  amount: {
    type: Number,
    required: [true, "Amount is required"],
    min: [0, "Amount cannot be negative"]
  },
  dateIncurred: {
    type: Date,
    required: [true, "Date incurred is required"]
  },
  description: {
    type: String,
    trim: true,
  },
  receiptUrl: {
    type: String, // Cloudinary URL if they uploaded a picture of the bill
  }
});

const expenseSchema = new mongoose.Schema({
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
    index: true
  },
  month: {
    type: String,
    required: true,
    trim: true,
    match: [/^\d{4}-\d{2}$/, 'Month must be in YYYY-MM format (e.g., 2026-02)'],
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    default: function() {
      return `Expense Claim - ${this.month}`;
    }
  },
  items: [expenseItemSchema],
  totalClaimedAmount: {
    type: Number,
    default: 0
  },
  totalApprovedAmount: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected', 'Reimbursed'],
    default: 'Pending',
    index: true
  },
  rejectionReason: {
    type: String,
    trim: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User' // The Admin or HR Manager who approved it
  },
  processedAt: {
    type: Date // Date it was Approved or Rejected
  },
  reimbursedAt: {
    type: Date // Date the money was actually paid out to the employee
  },
  adminComments: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Pre-save hook to automatically calculate the total claimed amount securely
expenseSchema.pre('save', function(next) {
  if (this.items && this.items.length > 0) {
    this.totalClaimedAmount = this.items.reduce((sum, item) => sum + (item.amount || 0), 0);
  } else {
    this.totalClaimedAmount = 0;
  }
  next();
});

export const Expense = mongoose.model('Expense', expenseSchema);