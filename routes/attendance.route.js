import express from "express";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";
import { bulkCreateAttendance, createAttendance, deleteAttendance, getAllAttendanceForMonth, getAllAttendanceForWeek, getAttendanceById, getAttendanceByMonth, getAttendanceByWeek, getFilteredAttendance, updateAttendance } from "../controllers/attendance.controller.js";

const attendanceRouter = express.Router();

attendanceRouter.post("/create",ClerkExpressRequireAuth(),createAttendance)
attendanceRouter.get("/getById",ClerkExpressRequireAuth(),getAttendanceById)
attendanceRouter.get("/getByMonth",ClerkExpressRequireAuth(),getAttendanceByMonth);
attendanceRouter.get("/getAllForMonth",ClerkExpressRequireAuth(),getAllAttendanceForMonth)
attendanceRouter.get("/getByWeek",ClerkExpressRequireAuth(),getAttendanceByWeek);
attendanceRouter.get("/getAllForWeek",ClerkExpressRequireAuth(),getAllAttendanceForWeek)
attendanceRouter.put("/update/:id",ClerkExpressRequireAuth(),updateAttendance)
attendanceRouter.delete("/delete/:id",ClerkExpressRequireAuth(),deleteAttendance)
attendanceRouter.get("/getAll",ClerkExpressRequireAuth(),getFilteredAttendance)
attendanceRouter.post("/bulk-import",ClerkExpressRequireAuth(),bulkCreateAttendance)

export {attendanceRouter}
