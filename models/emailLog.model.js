import mongoose from "mongoose";


const emailLogSchema = new mongoose.Schema({
    template: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmailTemplate',
      required: true
    },
    to: {
      type: String,
      required: true,
      trim: true
    },
    subject: {
      type: String,
      required: true,
      trim: true
    },
    variables: {
      type: Object,
      default: {}
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    status: {
      type: String,
      enum: ['queued', 'sent', 'failed'],
      default: 'queued'
    },
    error: {
      type: String
    },
    sentAt: {
      type: Date
    },
    priority: {
      type: String,
      enum: ['high', 'normal', 'low'],
      default: 'normal'
    },
  }, { timestamps: true });


  emailLogSchema.index({ status: 1 });
emailLogSchema.index({ sentBy: 1 });
emailLogSchema.index({ template: 1 });
emailLogSchema.index({ createdAt: -1 });
emailLogSchema.index({ to: 1 });

  const EmailLog = mongoose.model('EmailSchema',emailLogSchema);
  export {EmailLog}