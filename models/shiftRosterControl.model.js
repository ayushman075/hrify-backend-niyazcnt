import mongoose from "mongoose";

const rosterControlSchema = new mongoose.Schema({
    month: {
      type: String, // Format: yyyy-mm
      required: true,
      unique: true,
    },
    isFinalized: {
      type: Boolean,
      default: false,
    },
  });
  
  export const RosterControl = mongoose.model("RosterControl", rosterControlSchema);
  