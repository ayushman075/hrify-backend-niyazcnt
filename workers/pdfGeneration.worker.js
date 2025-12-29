import { Worker } from "bullmq";
import { generateExperienceLetterPDF,generateJoiningLetterPDF,generateOfferLetterPDF, generatePayrollPDF } from "../services/pdfGenerator.js";
import { redis } from "../db/redis.config.js";

const pdfGeneratorWorker = new Worker('pdfGenerationQueue', async job => {
  const { type,requestBody } = job.data;

 if(type=='offerLetter'){
   await generateOfferLetterPDF(requestBody);
 }
 if(type=='joiningLetter'){
   await generateJoiningLetterPDF(requestBody);
 }
 if(type=='experienceLetter'){
   await generateExperienceLetterPDF(requestBody);
 }
 if(type=='payrollSlip'){
  await generatePayrollPDF(requestBody);
}
}, {
  connection:redis
});

pdfGeneratorWorker.on('completed', job => {
  console.log(`Job ${job.id} has been completed`);
});

pdfGeneratorWorker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed: ${err.message}`);
});



export {pdfGeneratorWorker}