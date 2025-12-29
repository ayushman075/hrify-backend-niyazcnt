import { Router } from 'express';
import { approvePost,disapprovePost, createPost, deletePost, getAllPosts, getPost, updatePost } from '../controllers/post.controller.js';
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";



const postRouter = Router();

postRouter.post('/create', ClerkExpressRequireAuth(),  createPost);
postRouter.get('/getAll',  ClerkExpressRequireAuth(), getAllPosts);
postRouter.get('/get/:id', ClerkExpressRequireAuth(),  getPost);
postRouter.put('/update/:id', ClerkExpressRequireAuth(), updatePost);
postRouter.put('/approve/:id', ClerkExpressRequireAuth(), approvePost);
postRouter.put('/disapprove/:id', ClerkExpressRequireAuth(), disapprovePost);
postRouter.delete('/delete/:id', ClerkExpressRequireAuth(), deletePost); 

export {postRouter}
