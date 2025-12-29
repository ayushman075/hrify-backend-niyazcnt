import mongoose from "mongoose";

const noticeSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Notice title is required"],
      trim: true,
    },
    content: {
      type: String,
      required: [true, "Notice content is required"],
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
    },
    noticeType: {
      type: String,
      required: [true, "Notice type is required"],
      enum: ["General", "Policy", "Announcement", "Event", "Holiday", "Emergency", "Other"],
    },
    validFrom: {
      type: Date,
      default: Date.now,
    },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High", "Urgent"],
      default: "Medium",
    },
    attachments: [
      {
        name: String,
        fileUrl: String,
        fileType: String,
        fileSize: Number,
      },
    ],
    viewedBy: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        viewedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);


noticeSchema.index({ title: "text", content: "text" });

noticeSchema.index({ department: 1, noticeType: 1 });


noticeSchema.methods.markAsViewed = async function(userId) {
  const viewRecord = this.viewedBy.find(
    view => view.user.toString() === userId.toString()
  );
  
  if (viewRecord) {
    // Update existing view timestamp
    viewRecord.viewedAt = new Date();
  } else {
    // Add new view record
    this.viewedBy.push({
      user: userId,
      viewedAt: new Date()
    });
  }

  await this.save();
  return this;
};

export const Notice = mongoose.model("Notice", noticeSchema);