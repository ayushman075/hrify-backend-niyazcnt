import Attendance from "../models/attendance.model.js";
import { Leave } from "../models/leave.model.js";
import LeaveLimit from "../models/leaveLimit.model.js";
import { LeaveConfig } from "../models/leaveConfig.model.js";
import { User } from "../models/user.model.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/AsyncHandler.js";
import {Employee} from "../models/employee.model.js"

export const applyForLeave = asyncHandler(async (req, res) => {
  const { employeeId, leaveType, startDate, endDate, reason } = req.body;

  if (!employeeId || !leaveType || !startDate || !endDate || !reason) {
    return res
      .status(400)
      .json(new ApiResponse(400, {}, "Required fields are missing", false));
  }

  const leaveConfig = await LeaveConfig.findById(leaveType);
  if (!leaveConfig) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Invalid leave type. Leave configuration not found.", false));
  }

  const overlappingLeaves = await Leave.find({
    employeeId,
    status: { $in: ['Pending', 'Approved'] },
    $or: [
      { startDate: { $lte: new Date(endDate) }, endDate: { $gte: new Date(startDate) } },
    ],
  });

  if (overlappingLeaves.length > 0) {
    return res
      .status(409)
      .json(new ApiResponse(409, {}, "There are overlapping leaves for the selected dates", false));
  }

  const leaveApplication = new Leave({
    employeeId,
    leaveType,
    startDate,
    endDate,
    reason,
  });

  await leaveApplication.save();

  return res
    .status(201)
    .json(new ApiResponse(201, leaveApplication, "Leave application submitted successfully", true));
});




export const approveOrDisapproveLeave = asyncHandler(async (req, res) => {
  const { id, status, comments } = req.body;
  const userId = req.auth.userId;

  // Validate status
  if (!status || !['Approved', 'Disapproved', 'Pending'].includes(status)) {
    return res
      .status(400)
      .json(new ApiResponse(400, {}, "Invalid status. Must be 'Approved' or 'Disapproved'", false));
  }

  // Validate user authorization
  const user = await User.findOne({ userId });
  if (!user || !(user.role === 'Admin' || user.role === 'HR Manager' ||
    user.role === 'HR Assistance' || user.role === 'Head Of Department')) {
    return res
      .status(403)
      .json(new ApiResponse(403, {}, "Unauthorized access !!", false));
  }

  // Find leave application
  const leaveApplication = await Leave.findById(id)
    .populate('leaveType')
    .populate('employeeId');

  if (!leaveApplication) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Leave application not found", false));
  }

  const previousStatus = leaveApplication.status;

  if (status === 'Approved' && previousStatus !== 'Approved') {
    const leaveDays = Math.ceil(
      (new Date(leaveApplication.endDate) - new Date(leaveApplication.startDate)) / (1000 * 60 * 60 * 24) + 1
    );

    // Find or create leave limit
    let leaveLimit = await LeaveLimit.findOne({
      employeeId: leaveApplication.employeeId
    });

    if (!leaveLimit) {
      const employee = await Employee.findById(leaveApplication.employeeId);
      if (!employee) {
        return res
          .status(404)
          .json(new ApiResponse(404, {}, "Employee not found", false));
      }

      const leaveConfigs = await LeaveConfig.find({ posts: employee.post });
      if (!leaveConfigs || leaveConfigs.length === 0) {
        return res
          .status(404)
          .json(new ApiResponse(404, {}, "No leave configurations found for the employee's post", false));
      }

      // Initialize leave details based on existing configs
      const leaveDetails = leaveConfigs.map(config => {
        const daysSinceJoining = Math.ceil(
          (new Date() - new Date(employee.dateOfJoining)) / (1000 * 60 * 60 * 24)
        );
        const isEligible = daysSinceJoining >= config.eligibilityDays;

        return {
          leaveType: config._id,
          usedLeaves: 0,
          remainingLeaves: isEligible ? config.totalLeaves : 0
        };
      });

      // Create new leave limit record
      leaveLimit = await LeaveLimit.create({
        employeeId: employee._id,
        postId: employee.post,
        joinDate: employee.dateOfJoining,
        leaveDetails,
        lastRefreshed: new Date()
      });
    }

    const leaveDetail = leaveLimit.leaveDetails.find(
      detail => detail.leaveType.toString() === leaveApplication.leaveType._id.toString()
    );

    if (!leaveDetail) {
      const employee = await Employee.findById(leaveApplication.employeeId);
      if (!employee) {
        return res
          .status(404)
          .json(new ApiResponse(404, {}, "Employee not found", false));
      }

      const leaveConfigs = await LeaveConfig.findById(leaveApplication.leaveType._id);
      if (!leaveConfigs || leaveConfigs.length === 0) {
        return res
          .status(404)
          .json(new ApiResponse(404, {}, "No leave configurations found for the employee's post", false));
      }

      const daysSinceJoining = Math.ceil(
        (new Date() - new Date(employee.dateOfJoining)) / (1000 * 60 * 60 * 24)
      );
      const isEligible = daysSinceJoining >= leaveConfigs.eligibilityDays;

      const leaveLimit = await LeaveLimit.findOne({ employeeId: employee._id });
      leaveLimit?.leaveDetails?.push({
        leaveType: leaveConfigs._id,
        usedLeaves: 0,
        remainingLeaves: isEligible ? leaveConfigs.totalLeaves : 0
      })

      await leaveLimit.save();
      return res
        .status(404)
        .json(new ApiResponse(404, {}, "Leave type configuration not found for this employee, Please try again!", false));
    }

    // Check leave balance
    if (leaveDays > leaveDetail.remainingLeaves) {
      leaveApplication.status = 'Disapproved';
      leaveApplication.comments = 'Insufficient leave balance';
      leaveApplication.approvedOrDisapprovedBy = user._id;
      await leaveApplication.save();
      return res
        .status(409)
        .json(new ApiResponse(409, {}, "Insufficient leave balance for the requested leave type", false));
    }

    // Create attendance records
    const attendanceRecords = [];
    const currentDate = new Date(leaveApplication.startDate);
    const endDate = new Date(leaveApplication.endDate);

    while (currentDate <= endDate) {
      
      // --- Week Calculation Logic (WWYY) ---
      const d = new Date(Date.UTC(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()));
      const yearShort = d.getUTCFullYear().toString().slice(-2);
      
      // Calculate ISO Week Number
      const dayNum = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
      
      // Format as 0225
      const week = `${weekNo.toString().padStart(2, '0')}${yearShort}`;
      // -------------------------------------

      attendanceRecords.push({
        employeeId: leaveApplication.employeeId,
        date: new Date(currentDate),
        month: new Date(currentDate).toISOString().slice(0, 7),
        week: week, // Added week field
        isLeave: true,
        leaveId: leaveApplication._id
      });
      currentDate.setDate(currentDate.getDate() + 1);
    }

    if (attendanceRecords.length > 0) {
      await Attendance.insertMany(attendanceRecords);
    }
    leaveDetail.remainingLeaves -= leaveDays;
    leaveDetail.usedLeaves += leaveDays;
    await leaveLimit.save();
  }

  // Handle moving from Approved to other status
  else if (previousStatus === 'Approved' && status !== 'Approved') {
    const leaveDays = Math.ceil(
      (new Date(leaveApplication.endDate) - new Date(leaveApplication.startDate) + 1) / (1000 * 60 * 60 * 24) + 1
    );

    const leaveLimit = await LeaveLimit.findOne({
      employeeId: leaveApplication.employeeId
    });

    if (leaveLimit) {
      const leaveDetail = leaveLimit.leaveDetails.find(
        detail => detail.leaveType.toString() === leaveApplication.leaveType._id.toString()
      );

      if (leaveDetail) {
        leaveDetail.remainingLeaves += leaveDays;
        leaveDetail.usedLeaves -= leaveDays;
        await leaveLimit.save();
      }
    }

    await Attendance.deleteMany({
      employeeId: leaveApplication.employeeId,
      leaveId: leaveApplication._id
    });
  }

  leaveApplication.status = status;
  leaveApplication.comments = comments || leaveApplication.comments;
  leaveApplication.approvedOrDisapprovedBy = user._id;
  await leaveApplication.save();

  return res
    .status(200)
    .json(new ApiResponse(200, leaveApplication, `Leave application ${status.toLowerCase()} successfully`, true));
});



  export const updateLeaveApplication = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { comments, reason, startDate: newStartDate, endDate: newEndDate } = req.body;
    const userId = req.auth.userId;
  
    // Find the leave application
    const leaveApplication = await Leave.findById(id)
      .populate('leaveType')
      .populate('employeeId');
  
    if (!leaveApplication) {
      return res
        .status(404)
        .json(new ApiResponse(404, {}, "Leave application not found.", false));
    }

    const user = await User.findOne({userId})
  
    // Check if the leave application belongs to the requesting user
    if (!user || (leaveApplication.employeeId._id.toString() !== userId && user.role=='Employee')) {
      return res
        .status(403)
        .json(new ApiResponse(403, {}, "You are not authorized to update this leave application.", false));
    }

    // Only allow updates if the leave is in Pending status
    if (leaveApplication.status !== 'Pending') {
      return res
        .status(400)
        .json(new ApiResponse(400, {}, "Only pending leave applications can be updated.", false));
    }
  
    // Update the leave application fields
    if (newStartDate) leaveApplication.startDate = newStartDate;
    if (newEndDate) leaveApplication.endDate = newEndDate;
    if (comments) leaveApplication.comments = comments;
    if (reason) leaveApplication.reason = reason;
  
    const updatedLeaveApplication = await leaveApplication.save();
  
    return res
      .status(200)
      .json(new ApiResponse(200, updatedLeaveApplication, "Leave application updated successfully.", true));
});




  export const deleteLeaveApplication = asyncHandler(async (req, res) => {
    const { id } = req.params;
  
    const leaveApplication = await Leave.findById(id);
  
    if (!leaveApplication) {
      return res
        .status(404)
        .json(new ApiResponse(404, {}, "Leave application not found.", false));
    }
  
    if (leaveApplication.status !== 'Pending') {
      return res
        .status(409)
        .json(new ApiResponse(409, {}, "Cannot delete leave applications that are already processed.", false));
    }
  
    await Leave.findByIdAndDelete(id);
  
    return res
      .status(200)
      .json(new ApiResponse(200, {}, "Leave application deleted successfully.", true));
  });


  export const getLeaveApplicationById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const currentDate = new Date();
    const employees = await LeaveLimit.find();
  
    const updatedEmployees = [];
  
    for (const employee of employees) {
      const { joinDate, leaveDetails, lastRefreshed } = employee;
  
      const yearsOfService = Math.floor((currentDate - new Date(joinDate)) / (365 * 24 * 60 * 60 * 1000));
      const lastRefreshYear = new Date(lastRefreshed).getFullYear();
  
      if (yearsOfService > 0 && lastRefreshYear < currentDate.getFullYear()) {
        leaveDetails.forEach((detail) => {
          if (detail.carryForward) {
            detail.remainingLeaves += detail.maxLeaves - detail.usedLeaves;
          } else {
            detail.remainingLeaves = detail.maxLeaves;
          }
          detail.usedLeaves = 0;
        });
  
        employee.lastRefreshed = currentDate;
        await employee.save();
        updatedEmployees.push(employee);
      }
    }
  
  
    const leaveApplication = await Leave.findById(id)
      .populate('leaveType', 'leaveName maxLeaves') 
      .populate('employeeId', 'name employeeCode') 
      .populate('postId', 'name'); 
  
    if (!leaveApplication) {
      return res
        .status(404)
        .json(new ApiResponse(404, {}, "Leave application not found.", false));
    }
  
    return res
      .status(200)
      .json(new ApiResponse(200, leaveApplication, "Leave application retrieved successfully.", true));
  });
  

  export const getAllLeaveApplications = asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 10,
      sortBy = 'appliedOn',
      sortOrder = 'desc',
      employeeId,
      leaveType,
      status,
      startDate,
      endDate,
    } = req.query;
  
    const pageNumber = parseInt(page, 10);
    const pageLimit = parseInt(limit, 10);
    const sortOrderValue = sortOrder === 'desc' ? -1 : 1;
  

    const currentDate = new Date();
    const employees = await LeaveLimit.find().populate("leaveDetails.leaveType"); 
  
    const updatedEmployees = [];
  
    for (const employee of employees) {
      const { joinDate, leaveDetails, lastRefreshed } = employee;
  
      const yearsOfService = Math.floor((currentDate - new Date(joinDate)) / ( 24 * 60 * 60 * 1000));
      const lastRefreshYear = new Date(lastRefreshed).getFullYear();
  
     
        leaveDetails.forEach((detail) => {
          if (yearsOfService % detail.leaveType.validityDays==0 ) {
          if (detail.carryForward) {
            detail.remainingLeaves += 2*detail.leaveType.totalLeaves - detail.usedLeaves;
          } else {
            detail.remainingLeaves = detail.leaveType.totalLeaves;
          }
          detail.usedLeaves = 0;
        }
        });
  
        employee.lastRefreshed = currentDate;
        await employee.save();
        updatedEmployees.push(employee);
     
    }

    if(employeeId){
      const employeeDetails = await Employee.findById(employeeId);
      const leaveLimitDetails = await LeaveLimit.find({employeeId});
      const leaveConfigDetails = await LeaveConfig.find({posts:employeeDetails.post});




      if(leaveConfigDetails?.length!=leaveLimitDetails[0]?.leaveDetails?.length){
        const existingLeaveId = leaveLimitDetails[0]?.leaveDetails?.map(lld => lld.leaveType) || [];

        console.log("Existing Leave IDs:", existingLeaveId);
        
        const leftLeaveConfig = leaveConfigDetails.filter(lcd => {
          return !existingLeaveId.some(id => id.equals(lcd._id));
        });
        
        console.log("Left Leave Config:", leftLeaveConfig);
        
        

        const leaveDetails = leftLeaveConfig?.map((config) => (leaveLimitDetails[0]?.leaveDetails?.push({
          leaveType: config._id, // Make sure this is an ObjectId, not a string
          maxLeaves: config.totalLeaves,
          usedLeaves: 0,
          remainingLeaves: config.totalLeaves, // This ensures remainingLeaves is set
          eligibilityDays: config.eligibilityDays || 0,
          carryForward: config.carryForward,
          encashable: config.encashable,
        })));

        await leaveLimitDetails[0]?.save();
      }
      
    }
  

    const filterConditions = {};
  
    // Add optional filters
    if (employeeId) filterConditions.employeeId = employeeId;
    if (leaveType) filterConditions.leaveType = leaveType;
    if (status) filterConditions.status = status;
  
  
    const leaveApplications = await Leave.find(filterConditions)
      .populate('leaveType', 'leaveType') // Populate leaveType details
      .populate('employeeId', 'firstName lastName employeeId') // Populate employee details
      .skip((pageNumber - 1) * pageLimit) // Pagination: skip
      .limit(pageLimit) // Pagination: limit
      .sort({ [sortBy]: sortOrderValue }); // Sorting
  
    const totalLeaveApplications = await Leave.countDocuments(filterConditions);
    const totalPages = Math.ceil(totalLeaveApplications / pageLimit);
  
    return res.status(200).json(
      new ApiResponse(
        200,
        {
          leaveApplications,
            totalPages,
            currentPage: pageNumber,
            totalLeaveApplications,
        },
        'Leave applications retrieved successfully.',
        true
      )
    );
  });
  
  