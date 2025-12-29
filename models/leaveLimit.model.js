import mongoose from "mongoose";

const leaveLimitSchema = new mongoose.Schema({
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Employee",
    required: true,
  },
  postId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Post",
    required: true,
  },
  joinDate: {
    type: Date,
    required: true,
  },
  leaveDetails: [
    {
      leaveType: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "LeaveConfig",
        required: true,
      },
      usedLeaves: {
        type: Number,
        default: 0,
      },
      remainingLeaves: {
        type: Number,
      },
    },
  ],
  lastRefreshed: {
    type: Date,
    required: true,
  },
});

const LeaveLimit = mongoose.model("LeaveLimit", leaveLimitSchema);

export default LeaveLimit;
