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
      required: function() { return !this.isWeekOff; }
    },
    isWeekOff: {
      type: Boolean,
      default: false
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
      type: String, 
      required: true,
    },
    // --- NEW FIELD ADDED ---
    week: { 
      type: String, 
      required: true,
    },
});
  
shiftRosterSchema.index({ employeeId: 1, date: 1 }, { unique: true });

export const ShiftRoster = mongoose.model("ShiftRoster", shiftRosterSchema);