import nodemailer from 'nodemailer'
import dotenv from "dotenv";
import { EmailLog } from '../models/emailLog.model.js';

dotenv.config({
  path:'.env'
});




const sendMail = async (requestOption) => {

    const transporter = nodemailer.createTransport({
        service: process.env.NODEMAILER_SERVICE_PROVIDER, 
        auth: {
          user: process.env.NODEMAILER_EMAIL,
          pass: process.env.NODEMAILER_PASSWORD,
        },
      });


    const mailOptions = {
        from: process.env.NODEMAILER_EMAIL,
        to: requestOption.to, 
        subject: requestOption.subject,
        text: requestOption.text,
        html: requestOption.html
      };
      
      // Send the email
      transporter.sendMail(mailOptions,async (error, info) => {
        if (error) {
        await EmailLog.findByIdAndUpdate(requestOption.metadata.logId,{status:'failed',sentAt:Date.now(),error:error.message})
         throw new Error(error)
        } else {
          await EmailLog.findByIdAndUpdate(requestOption.metadata.logId,{status:'sent',sentAt:Date.now()})

          return info.rejected
          
        }
      });


}


export {sendMail}

