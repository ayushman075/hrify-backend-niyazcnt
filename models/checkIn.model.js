import mongoose from "mongoose";

const checkInSchema = new mongoose.Schema({
    status: { 
        type: String, 
        enum: ["PENDING", "SUCCESS", "FAILED"], 
        default: "PENDING" 
    },
    type: {
        type: String,
        enum: ["in", "out"],
        required: true
    },
    date: { type: Date, default: Date.now },
    time: { type: Date, default: Date.now },
    read: {type: Boolean, default: false },
    
    message: { type: String }, 
    identifiedEmployeeId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User' 
    },
        
    createdAt: { type: Date, default: Date.now } 
});

export const CheckIn = mongoose.model("CheckIn", checkInSchema);