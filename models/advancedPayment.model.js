import mongoose from 'mongoose';

const advancePaymentSchema = new mongoose.Schema({
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    requestedDate: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'paid'],
      default: 'pending'
    },
    month: {
      type: String,
      required: true
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    approvedAt: Date,
    reason: String,
    remarks: String
  }, {
    timestamps: true
  });
  
  export const AdvancePayment = mongoose.model('AdvancePayment', advancePaymentSchema);
  