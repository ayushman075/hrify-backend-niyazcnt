import moment from 'moment';

const attendanceMatrix = {
  underWorked: {
    deductionPercentage: 0.5, // Deduct 0.5% for every minute underworked
    threshold: 0.8,           // If worked time is less than 80% of scheduled time, apply deduction
  },
  overWorked: {
    bonusPercentage: 0.2,     // Add 0.2% for every minute overworked
    threshold: 1.2,           // If worked time is more than 120% of scheduled time, apply bonus
  },
};

// Function to calculate attendance percentage
const calculateAttendancePercentage = (workedTime, scheduledTime) => {
  let percentage = (workedTime / scheduledTime) * 100;

  // Check if underworked
  if (percentage < (attendanceMatrix.underWorked.threshold * 100)) {
    const underworkedTime = scheduledTime - workedTime;
    const deduction = underworkedTime * attendanceMatrix.underWorked.deductionPercentage;
    percentage -= deduction;
  }

  // Check if overworked
  if (percentage > (attendanceMatrix.overWorked.threshold * 100)) {
    const overtime = workedTime - scheduledTime;
    const bonus = overtime * attendanceMatrix.overWorked.bonusPercentage;
    percentage += bonus;
  }

  // Ensure percentage stays within 0-100
  percentage = Math.max(0, Math.min(100, percentage));

  return percentage;
};

// Calculate late deduction in minutes
const calculateLateDeduction = (punchInTime, scheduledStartTime) => {
  const lateMinutes = moment(punchInTime).diff(moment(scheduledStartTime), 'minutes');
  // Deduct 1% for every 10 minutes late
  return lateMinutes > 0 ? (lateMinutes / 10) * 0.5 : 0;
};

// Calculate overtime in minutes
const calculateOvertime = (punchOutTime, scheduledEndTime) => {
  const overtimeMinutes = moment(punchOutTime).diff(moment(scheduledEndTime), 'minutes');
  // Award 1% for every 10 minutes overtime
  return overtimeMinutes > 0 ? (overtimeMinutes / 10) * 0.2 : 0;
};

export { calculateAttendancePercentage, calculateLateDeduction, calculateOvertime };
