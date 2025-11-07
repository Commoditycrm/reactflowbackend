import { Router, RouterOptions } from "express";
import createOwner from "../controllers/auth/createOwner";

const authRouter = Router();

authRouter.post("/createOwner", createOwner);


export default authRouter