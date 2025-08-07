import { Request, Response } from "express";
import { getFirebaseAdminAuth } from "../../graphql/firebase/admin";
import { signInWithEmailAndPassword } from "firebase/auth";


const login = async (req: Request, res: Response) => {
    const { email, password } = req.body
    if (!email || !password) {
        return res.status(400).json({ message: "email and password required" })
    }
    try {
        // const user = await signInWithEmailAndPassword(getFirebaseAdminAuth().auth(),email,password)
        // console.log(user)
        res.status(200).json({ message: "Ok" })
    } catch (error) {
        res.status(500).json(error)
    }
}

export default login