import { Queue } from "bullmq";
import dotenv from 'dotenv';
import Redis from "ioredis";

dotenv.config({
  path:'.env'
});

console.log( "host: "+process.env.REDIS_URL)


const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,   
});

redis.on("connect", () => {
  console.log("Connected to Redis successfully!");
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err);
  throw new Error("Redis connection Error")
});


const emailQueue = new Queue('emailQueue',{
    connection:redis,
})
const pdfGenerationQueue = new Queue('pdfGenerationQueue',{
  connection:redis,
})

export {emailQueue,pdfGenerationQueue,redis}

