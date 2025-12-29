import dotenv from "dotenv";
import express from 'express';
const app = express();
import connectDB from "./db/db.config.js";
import cors from "cors";
import cookieParser from "cookie-parser";


dotenv.config({
  path:'.env'
});

app.use(cors({
  origin:['http://localhost:5174','http://localhost:8081','https://iridescent-parfait-9b7d28.netlify.app','*','http://localhost:5173','https://hrify-frontend-plum.vercel.app','https://hrify-frontend-crvwhg7b2-ayushman075s-projects.vercel.app'],
  credentials:true,
 methods:['GET','POST','DELETE','PUT','PATCH'],
 
 allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({limit:"16kb"}));
app.use(express.urlencoded({extended:true,
  limit:"16kb"
}));
app.use(express.static("public"));
app.use(cookieParser())


import { userRouter } from "./routes/user.route.js";
import { postRouter } from "./routes/post.route.js";
import { employeeRouter } from "./routes/employee.route.js";
import { candidateRouter } from "./routes/candidate.route.js";
import shiftRouter from "./routes/shift.route.js";
import { shiftRosterRouter } from "./routes/shiftRoster.route.js";
import { attendanceRouter } from "./routes/attendance.route.js";
import { leaveApplicationRouter } from "./routes/leave.route.js";
import leaveConfigRouter from "./routes/leaveConfig.route.js";
import { payrollRouter } from "./routes/payroll.route.js";
import { advancePaymentConfigRouter } from "./routes/advancedPaymentConfig.route.js";
import { advancePaymentRouter } from "./routes/advancedPayment.route.js";
import { departmentRouter } from "./routes/department.route.js";

import { emailQueue, pdfGenerationQueue } from "./db/redis.config.js";
import { emailWorker } from "./workers/mail.worker.js";
import { pdfGeneratorWorker } from "./workers/pdfGeneration.worker.js";
import { holidayRouter } from "./routes/holidays.route.js";
import { noticeRouter } from "./routes/notice.route.js";
import { dashboardRouter } from "./routes/dashboard.routes.js";
import { emailTemplateRouter } from "./routes/emailTemplate.route.js";
import { emailLogRouter } from "./routes/emailLog.route.js";
import { pdfRouter } from "./routes/pdfGeneration.route.js";
import leaveLimitRouter from "./routes/leaveLimit.route.js";
import { startAttendanceReconciliationCron } from "./services/biometricCron.service.js";
import biometricRouter from "./routes/biometricAttendance.route.js";





app.use("/api/v1/user",userRouter)
app.use("/api/v1/post",postRouter)
app.use("/api/v1/employee",employeeRouter)
app.use("/api/v1/candidate",candidateRouter)
app.use("/api/v1/shift",shiftRouter)
app.use("/api/v1/shiftRoster",shiftRosterRouter)
app.use("/api/v1/attendance",attendanceRouter)
app.use("/api/v1/leave",leaveApplicationRouter)
app.use("/api/v1/leaveConfig",leaveConfigRouter)
app.use("/api/v1/leaveLimit",leaveLimitRouter)

app.use("/api/v1/payroll",payrollRouter)
app.use("/api/v1/advancePaymentConfig",advancePaymentConfigRouter)
app.use("/api/v1/advancePayment",advancePaymentRouter)
app.use("/api/v1/department",departmentRouter)
app.use("/api/v1/holidays",holidayRouter)
app.use("/api/v1/notice",noticeRouter)
app.use("/api/v1/dashboard",dashboardRouter)
app.use("/api/v1/emailTemplate",emailTemplateRouter)
app.use("/api/v1/email",emailLogRouter)
app.use("/api/v1/pdf",pdfRouter)
app.use("/api/v1/biometric",biometricRouter);


//startAttendanceReconciliationCron()


// try {
//   const requestOption1 = {
//     type:'offerLetter',
//     requestBody:{
//   candidateName: 'John Doe',
//   jobTitle: 'Software Engineer',
//   companyName: 'TechCorp',
//   joiningDate: '2024-02-01',
//   salaryDetails: '$80,000 per annum',
//   workLocation: 'Remote',
//   acceptanceDeadline: '2024-01-15',
//   department:"Accounts",
//   hrName: 'Jane Smith',
//   candidateId:100006
//     }
//   }
//   const requestOption2 = {
//     type:'joiningLetter',
//     requestBody:{
//   employeeName: 'Alex Rodriguez',
//   designation: 'Senior Software Engineer',
//   department: 'Engineering',
//   companyName: 'TechInnovate Solutions',
//   joiningDate: '2024-03-01',
//   salary: '₹1,200,000 per annum',
//   workLocation: 'Bangalore',
//   employeeId: 'EMP12345'
//     }
//   }
//   const requestOption3 = {
//     type:'experienceLetter',
//     requestBody:{
//       employeeName: 'Alex Rodriguez',
//       jobTitle: 'Senior Software Engineer',
//       department: 'Engineering',
//       companyName: 'TechInnovate Solutions',
//       startDate: '2022-01-15',
//       endDate: '2024-01-15',
//       employmentType: 'Full-time',
//       employeeId: 'EMP12345',
//       gender: 'male',
//       responsibility1: 'Led software development team of 5 engineers',
//       responsibility2: 'Developed and maintained critical backend systems',
//       responsibility3: 'Implemented CI/CD pipelines to improve deployment efficiency',
//       signatoryName: 'Jane Smith',
//       signatoryTitle: 'HR Director'
//     }
//   }
//   pdfGenerationQueue.add('pdf1',requestOption1,{
//     removeOnComplete: true,
//     removeOnFail: true,
//   }).then(()=>{
//     console.log("Request 1 added to queue sucessfully!")
//   });
//   pdfGenerationQueue.add('pdf2',requestOption2,{
//     removeOnComplete: true,
//     removeOnFail: true,
//   }).then(()=>{
//     console.log("Request 2 added to queue sucessfully!")
//   });
//   pdfGenerationQueue.add('pdf3',requestOption3,{
//     removeOnComplete: true,
//     removeOnFail: true,
//   }).then(()=>{
//     console.log("Request 3 added to queue sucessfully!")
//   });
//   const myGreeting = () => {
//     emailQueue.add('email2',requestOption2,{
//        removeOnComplete: true,
//        removeOnFail: true,
//      }).then(()=>{
//        console.log("Request 2 added to queue sucessfully!")
//      })
//    }
//    setTimeout(myGreeting, 50000);
// } catch (error) {
//   console.log(error)
// }

emailWorker;
pdfGeneratorWorker;

const port = process.env.PORT||3005;

connectDB().then((res)=>
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  })
).catch(()=>{
//error handling start
console.log("Error connecting to database !!")
//error handling end
});

app.get('/', (req, res) => {
  res.send('Welcome to HRIFY, on this line you are taking to HRIFY server !!');
});
