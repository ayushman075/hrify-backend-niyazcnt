import mongoose from "mongoose";
const { Schema } = mongoose;

const postSchema = new Schema(
  {
    title: {
      type: String,
      required: [true, 'Post title is required'],
      trim: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: [true, 'Department is required'],
    },
    // --- New Field Added Here ---
    payrollType: {
      type: String,
      enum: [
        'Weekly_With_Sunday_Holiday',
        'Weekly_Without_Sunday_Holiday',
        'Monthly_With_Sunday_Holiday',
        'Monthly_Without_Sunday_Holiday'
      ],
      required: [true, 'Payroll type is required'],
    },
    // ----------------------------
    isPfPayable: {
      type: Boolean,
      default: false
    },
    salary: {
      basic: {
        type: Number,
        required: true,
      },
      houseRentAllowance: {
        type: Number,
      },
      dearnessAllowance: {
        type: Number,
      },
      perquisites: {
        type: Number,
      },
      others: {
        type: Number,
      },
      bonus: {
        type: Number,
      },
      variablePay: {
        type: Number,
      },
      taxes: {
        type: Number,
      },
      gross: {
        type: Number,
        required: true
      },
      total: {
        type: Number,
        required: true
      },
      providentFund: {
        employerContribution: {
          type: Number
        },
        employeeContribution: {
          type: Number
        }
      },
      esi: {
        employerContribution: {
          type: Number
        },
        employeeContribution: {
          type: Number
        }
      }
    },
    shiftTimings: [{
      name: String,
      startTime: String,
      endTime: String
    }],
    lateAttendanceMetrics: [{
      allowedMinutes: Number,
      attendanceDeductionPercent: Number
    }],
    workingHour: {
      type: Number,
      required: [true, 'Working hours are required'],
    },
    isHiring: {
      type: Boolean,
      default: false
    },
    isApproved: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ['Open', 'Closed', 'Pending'],
      default: 'Pending',
    },
    location: {
      type: String,
    },
    requirements: {
      type: [String],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

export const Post = mongoose.model('Post', postSchema);