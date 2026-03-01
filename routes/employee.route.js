import express from "express";
import { createEmployee, deleteEmployee, getAllEmployees, getEmployeeById, getEmployeesWithBirthdayToday, updateEmployee, uploadEmployeePhoto, uploadEmployeeSignature } from "../controllers/employee.controller.js";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";
import { upload } from "../middlewares/multer.middleware.js";


const employeeRouter = express.Router();

employeeRouter.post('/create' ,ClerkExpressRequireAuth(),createEmployee);

employeeRouter.get('/getAll' ,ClerkExpressRequireAuth(),getAllEmployees);

employeeRouter.get('/getEmployeeWithBirthday' ,ClerkExpressRequireAuth(),getEmployeesWithBirthdayToday);


employeeRouter.post("/uploadPhoto",ClerkExpressRequireAuth(), upload.single('photo'), uploadEmployeePhoto)

employeeRouter.post("/uploadSignature",ClerkExpressRequireAuth(), upload.single('signature'), uploadEmployeeSignature)


employeeRouter.get('/getById/:id' ,ClerkExpressRequireAuth(),getEmployeeById);

employeeRouter.put('/update/:id' ,ClerkExpressRequireAuth(),updateEmployee);

employeeRouter.delete('/delete/:id' ,ClerkExpressRequireAuth(),deleteEmployee);

export {employeeRouter};
