import { Worker } from "bullmq";
import { sendMail } from "../services/mail.js";
import { redis } from "../db/redis.config.js";
import { EmailLog } from "../models/emailLog.model.js";

const emailWorker = new Worker('emailQueue', async job => {
  const { to, subject, text, html,metadata } = job.data;
  console.log(`Sending email to ${to}`);
 const requestOption = {
    to,
    subject,
    text,
    html,
    metadata
 }
 await sendMail(requestOption)
}, {
  connection:redis
});

emailWorker.on('completed', async job => {
  console.log(`Job ${job.id} has been completed`);
});

emailWorker.on('failed',async (job, err) => {
  console.error(`Job ${job.id} failed: ${err.message}`);
});



export {emailWorker}