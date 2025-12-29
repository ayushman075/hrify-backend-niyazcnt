import mongoose from "mongoose";

const shiftRosterSchema = new mongoose.Schema({
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    shiftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      required: true,
    },
    month: {
      type: String, // Format: yyyy-mm
      required: true,
    },
  });
  
  export const ShiftRoster = mongoose.model("ShiftRoster", shiftRosterSchema);
  