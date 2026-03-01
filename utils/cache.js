import { redis } from "../db/redis.config.js";


export const getCache = async (key) => {
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error(":: Redis Get Error:", error);
    return null; 
  }
};


export const setCache = async (key, data, ttl = 3600) => {
  try {
    await redis.setex(key, ttl, JSON.stringify(data));
  } catch (error) {
    console.error(":: Redis Set Error:", error);
  }
};


export const removeCache = async (key) => {
  try {
    await redis.del(key);
  } catch (error) {
    console.error(":: Redis Delete Error:", error);
  }
};


export const removeCachePattern = async (pattern) => {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(keys);
    }
  } catch (error) {
    console.error(":: Redis Pattern Delete Error:", error);
  }
};