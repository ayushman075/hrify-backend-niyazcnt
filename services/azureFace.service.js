import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.FACE_API_KEY;
const API_SECRET = process.env.FACE_API_SECRET;
const BASE_URL = process.env.FACE_ENDPOINT || 'https://api-us.faceplusplus.com/facepp/v3';

// Custom Name for the group of faces
const CUSTOM_FACESET_ID = 'hrify_employees_group_v2'; 

const getCommonParams = () => ({
    api_key: API_KEY,
    api_secret: API_SECRET,
});

// ==========================================
// 0. Helper: Robust Request Wrapper
// ==========================================
const makeRequestWithRetry = async (url, data, retries = 3) => {
    try {
        const response = await axios.post(url, data, {
            headers: data.getHeaders ? data.getHeaders() : undefined 
        });
        return response.data;
    } catch (error) {
        const errMsg = error.response?.data?.error_message;
        
        // Rate Limit Handling (Wait 2s and retry)
        if (errMsg === 'CONCURRENCY_LIMIT_EXCEEDED' && retries > 0) {
            console.log(`⚠️ Rate Limit Hit. Retrying in 2s... (${retries} left)`);
            await new Promise(res => setTimeout(res, 2000));
            return makeRequestWithRetry(url, data, retries - 1);
        }
        throw error;
    }
};

// ==========================================
// 1. Helper: Force Create FaceSet
// ==========================================
const ensureFaceSetExists = async () => {
    try {
        const createParams = new URLSearchParams({
            ...getCommonParams(),
            display_name: "HRify Employees",
            outer_id: CUSTOM_FACESET_ID,
            force_merge: '0'
        });
        
        await axios.post(`${BASE_URL}/faceset/create`, createParams);
        console.log("✅ FaceSet Created Successfully");
    } catch (error) {
        // If it already exists, that is GOOD. We ignore this error.
        const msg = error.response?.data?.error_message;
        if (msg === 'FACESET_EXIST') {
            return; 
        }
        if (msg === 'CONCURRENCY_LIMIT_EXCEEDED') {
            await new Promise(res => setTimeout(res, 2000));
            return ensureFaceSetExists();
        }
        console.error("FaceSet Init Warning:", msg);
    }
};

// ==========================================
// 2. Identify User
// ==========================================
export const identifyUserFromFace = async (imagePath) => {
    try {
        const formData = new FormData();
        formData.append('api_key', API_KEY);
        formData.append('api_secret', API_SECRET);
        formData.append('image_file', fs.createReadStream(imagePath));
        formData.append('outer_id', CUSTOM_FACESET_ID);
        formData.append('return_result_count', 1);

        const data = await makeRequestWithRetry(`${BASE_URL}/search`, formData);

        if (!data.faces || data.faces.length === 0) {
            return { identified: false, reason: "No face detected" };
        }

        const bestMatch = data.results[0];

        // 75% Confidence Threshold
        if (!bestMatch || bestMatch.confidence < 75) {
            return { identified: false, reason: "Face not recognized" };
        }

        return {
            identified: true,
            azurePersonId: bestMatch.user_id,
            confidence: bestMatch.confidence
        };

    } catch (error) {
        if (error.response?.data?.error_message === 'INVALID_OUTER_ID') {
            return { identified: false, reason: "System empty (No FaceSet)" };
        }
        return { identified: false, reason: "Service Error" };
    }
};

// ==========================================
// 3. Create Person (Initialize)
// ==========================================
export const createAzurePerson = async (name) => {
    // Generate a unique ID for the user
    return `user_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
};

// ==========================================
// 4. Add Face (Returns Token)
// ==========================================
export const addFaceToAzurePerson = async (personId, imagePath) => {
    try {
        // Step A: Detect Face
        const formData = new FormData();
        formData.append('api_key', API_KEY);
        formData.append('api_secret', API_SECRET);
        formData.append('image_file', fs.createReadStream(imagePath));

        const detectRes = await makeRequestWithRetry(`${BASE_URL}/detect`, formData);

        if (!detectRes.faces || detectRes.faces.length === 0) {
            throw new Error("No face detected in photo");
        }

        const faceToken = detectRes.faces[0].face_token;

        // Step B: Add to FaceSet
        const addParams = new URLSearchParams({
            ...getCommonParams(),
            outer_id: CUSTOM_FACESET_ID,
            face_tokens: faceToken
        });

        try {
            await makeRequestWithRetry(`${BASE_URL}/faceset/addface`, addParams);
        } catch (error) {
            const errMsg = error.response?.data?.error_message;

            // If FaceSet missing, create it and retry
            if (errMsg === 'INVALID_OUTER_ID' || errMsg === 'INVALID_FACESET_TOKEN') {
                console.log("⚠️ FaceSet missing. Creating now...");
                await ensureFaceSetExists();
                await new Promise(res => setTimeout(res, 1000));
                await makeRequestWithRetry(`${BASE_URL}/faceset/addface`, addParams);
            } else {
                throw error;
            }
        }

        // Step C: Link Face to User ID
        const linkParams = new URLSearchParams({
            ...getCommonParams(),
            face_token: faceToken,
            user_id: personId
        });
        await makeRequestWithRetry(`${BASE_URL}/face/setuserid`, linkParams);

        // *** IMPORTANT: Return the token so we can save it in MongoDB ***
        return faceToken;

    } catch (error) {
        console.error("Add Face Error:", error.response?.data || error.message);
        throw new Error("Failed to add face to Face++");
    }
};

// ==========================================
// 5. Remove Face (New Function)
// ==========================================
export const removeFaceFromAzurePerson = async (faceToken) => {
    if (!faceToken) return;

    try {
        const params = new URLSearchParams({
            ...getCommonParams(),
            outer_id: CUSTOM_FACESET_ID,
            face_tokens: faceToken
        });

        await makeRequestWithRetry(`${BASE_URL}/faceset/removeface`, params);
        console.log(`✅ Removed old face token: ${faceToken}`);
        return true;
    } catch (error) {
        // We log the warning but don't throw, so the update process continues
        console.warn("⚠️ Remove Face Warning:", error.response?.data?.error_message || error.message);
        return false;
    }
};

export const trainAzureGroup = async () => {
    // Face++ auto-trains, this is just for compatibility if needed
    return true;
};