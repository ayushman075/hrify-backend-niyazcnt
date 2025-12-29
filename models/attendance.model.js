import mongoose from 'mongoose';

const attendanceSchema = new mongoose.Schema({
  employeeId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Employee', 
    required: true 
  },
  date: { 
    type: Date, 
    required: true 
  },
  punchInTime: { 
    type: Date 
  },
  punchOutTime: { 
    type: Date 
  },
  isLeave: { 
    type: Boolean, 
    default: false 
  },
  leaveId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Leave' 
  },
  month: { 
    type: String, 
    required: true 
  },
  week: { 
    type: String, 
    required: true,
    trim: true,
    match: [/^\d{4}$/, 'Week must be in WWYY format (e.g., 0225)'] 
  },
  attendancePercentage: { 
    type: Number, 
    default: 0, 
    required: true 
  },
}, {
  timestamps: true 
});

const Attendance = mongoose.model('Attendance', attendanceSchema);

export default Attendance;