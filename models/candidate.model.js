import mongoose from 'mongoose'
const { Schema } = mongoose;

const CandidateSchema = new Schema({
  candidateId: {
    type: Number,
    unique: true,
  },
  name: { type: String, required: true },
  email: { type: String, required: true },
  contactNo: { type: String, required: true },
  post:{
    type:mongoose.Schema.Types.ObjectId,
    ref:"Post",
    required:true
  },
  applicationStatus: { type: String, default: "Pending",enum:['Pending','Withheld','Rejected','Interview Scheduled','Hired'] }, 
  applicationDate:{type:Date},
  interviewDate:{type:Date},
  appointmentDate:{type:Date},
  resumeUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
});

CandidateSchema.pre('validate', async function(next) {
  if (!this.candidateId) {
    const lastCandidate = await this.constructor.findOne().sort({ candidateId: -1 });
    this.candidateId = lastCandidate ? lastCandidate.candidateId + 1 : 100000;
  }
  next();
});

export const Candidate = mongoose.model("Candidate", CandidateSchema);
