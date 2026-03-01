import mongoose from "mongoose";

const leaveConfigSchema = new mongoose.Schema({
  leaveType: {
    type: String,
    required: true,
  },
  totalLeaves: {
    type: Number,
    required: true,
  },
  eligibilityDays: {
    type: Number,
    default: 0, 
  },
  carryForwardAllowed: {
    type: Boolean,
    default: false,
  },
  carryForwardLimit: {
    type: Number,
    default: 0, 
  },
  encashmentAllowed: {
    type: Boolean,
    default: false, 
  },
  encashmentLimit: {
    type: Number,
    default: 0, 
  },
  validityDays: {
    type: Number,
    default: 365, 
  },
  isPaidLeave: {
    type: Boolean,
    default: true,
  },
  posts: 
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post", 
      required: true,
    },
  user:{
   type: mongoose.Schema.Types.ObjectId,
    ref: "User", 
    required: true,
  }
},{timestamps:true});

const LeaveConfig = mongoose.model("LeaveConfig", leaveConfigSchema);

export  {LeaveConfig};
