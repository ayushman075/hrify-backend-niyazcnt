import { Shift } from "../models/shift.model.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/AsyncHandler.js";
import { ShiftRoster } from "../models/shiftRoster.model.js";
import { RosterControl } from "../models/shiftRosterControl.model.js";

export const createShift = asyncHandler(async (req, res) => {
  const { name, startTime, endTime, post } = req.body;

  if (!name || !startTime || !endTime || !post) {
    return res.status(400).json(new ApiResponse(400, {}, "All fields are required", false));
  }

  const shift = await Shift.create({ name, startTime, endTime, post });

  return res.status(201).json(new ApiResponse(201, shift, "Shift created successfully", true));
});

export const getAllShifts = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sort = "createdAt",
    order = "desc",
    filters = {},
  } = req.query;

  const query = {};

  // Apply filters based on shift schema
  if (filters.name) {
    query.name = { $regex: filters.name, $options: "i" };
  }
  if (filters.startTime) {
    query.startTime = { $regex: filters.startTime, $options: "i" };
  }
  if (filters.endTime) {
    query.endTime = { $regex: filters.endTime, $options: "i" };
  }
  if (filters.post) {
    query.post = filters.post; // Assuming post is an ObjectId reference
  }

  // Fetch shifts with pagination and sorting
  const shifts = await Shift.find(query)
    .populate("post", "title") // Populating the post reference with title
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  // Get total count for pagination
  const totalShifts = await Shift.countDocuments(query);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        success: true,
        totalShifts,
        totalPages: Math.ceil(totalShifts / limit),
        currentPage: parseInt(page),
        shifts,
      },
      "Shifts retrieved successfully",
      true
    )
  );
});
export const getShiftById = asyncHandler(async (req, res) => {
    const { shiftId } = req.params;
  
    if (!shiftId) {
      return res.status(400).json(new ApiResponse(400, {}, "Shift ID is required", false));
    }
  
    const shift = await Shift.findById(shiftId);
  
    if (!shift) {
      return res.status(404).json(new ApiResponse(404, {}, "Shift not found", false));
    }
  
    return res.status(200).json(new ApiResponse(200, shift, "Shift retrieved successfully", true));
  });
  

export const deleteShift = asyncHandler(async (req, res) => {
    const { shiftId } = req.params;
  
    if (!shiftId) {
      return res.status(400).json(new ApiResponse(400, {}, "Shift ID is required", false));
    }
  
    const isAssigned = await ShiftRoster.findOne({ shiftId });
    if (isAssigned) {
      return res.status(409).json(
        new ApiResponse(409, {}, "Shift cannot be deleted as it is assigned to one or more rosters", false)
      );
    }
  
const deletedShift = await Shift.findByIdAndDelete(shiftId);
  
    if (!deletedShift) {
      return res.status(404).json(new ApiResponse(404, {}, "Shift not found", false));
    }
  
    return res.status(200).json(new ApiResponse(200, deletedShift, "Shift deleted successfully", true));
  });
  


export const createShiftRoster = asyncHandler(async (req, res) => {
  const { employeeId, shiftId, date, post, month } = req.body;

  if (!employeeId || !shiftId || !date || !post || !month) {
    return res.status(400).json(new ApiResponse(400, {}, "All fields are required", false));
  }

  const existingShift = await ShiftRoster.findOne({ employeeId, date });
  if (existingShift) {
    return res.status(409).json(new ApiResponse(409, {}, "Employee already has a shift on this date", false));
  }

  const rosterEntry = await ShiftRoster.create({ employeeId, shiftId, date, post, month });

  return res.status(201).json(new ApiResponse(201, rosterEntry, "Shift roster created successfully", true));
});

export const getRoasterById = asyncHandler(async (req, res) => {
    const { rosterId } = req.params;
  
    if (!rosterId) {
      return res.status(400).json(new ApiResponse(400, {}, "Shift ID is required", false));
    }
  
    const shiftRoaster = await ShiftRoster.findById(rosterId);
  
    if (!shiftRoaster) {
      return res.status(404).json(new ApiResponse(404, {}, "Shift not found", false));
    }
  
    return res.status(200).json(new ApiResponse(200, shiftRoaster, "Shift retrieved successfully", true));
  });
  

export const deleteShiftRoster = asyncHandler(async (req, res) => {
    const { employeeId,shiftId,date } = req.query;
  
    const rosterEntry = await ShiftRoster.findOne({employeeId,shiftId,date});
    if (!rosterEntry) {
      return res.status(404).json(new ApiResponse(404, {}, "Shift roster entry not found", false));
    }
  
    await ShiftRoster.findOneAndDelete({employeeId,shiftId,date});
    return res.status(200).json(new ApiResponse(200, {}, "Shift roster entry deleted successfully", true));
  });
  




export const getPostShiftRoster = asyncHandler(async (req, res) => {
    const { post, month } = req.query;
  
    if (!post || !month) {
      return res.status(400).json(new ApiResponse(400, {}, "Post and month are required", false));
    }
  
    const rosters = await ShiftRoster.find({ post, month }).populate("shiftId").populate("employeeId").populate("post");
  
    return res.status(200).json(new ApiResponse(200, rosters, "Shift roster retrieved successfully", true));
  });


  export const getEmployeeShiftRoster = asyncHandler(async (req, res) => {
    const { employeeId, month } = req.query;
  
    if (!employeeId || !month) {
      return res.status(400).json(new ApiResponse(400, {}, "Employee ID and month are required", false));
    }
  
    const rosters = await ShiftRoster.find({ employeeId, month }).populate("shiftId");
  
    return res.status(200).json(new ApiResponse(200, rosters, "Employee shift roster retrieved successfully", true));
  });
  

  


  export const finalizeRoster = asyncHandler(async (req, res) => {
  const { month, isFinalized } = req.body;

  if (!month || typeof isFinalized !== "boolean") {
    return res.status(400).json(new ApiResponse(400, {}, "Month and isFinalized flag are required", false));
  }

  const rosterControl = await RosterControl.findOneAndUpdate(
    { month },
    { isFinalized },
    { upsert: true, new: true }
  );

  return res.status(200).json(
    new ApiResponse(200, rosterControl, `Roster ${isFinalized ? "finalized" : "unlocked"} successfully`, true)
  );
});
