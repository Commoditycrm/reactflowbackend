import { Request, Response } from "express";
import { getFirebaseAdminAuth } from "../../graphql/firebase/admin";
import { signInWithEmailAndPassword } from "firebase/auth";

const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  // if (!email || !password) {
  //     return res.status(400).json({ message: "email and password required" })
  // }
  // const token = await getFirebaseAdminAuth().auth().createCustomToken("rBxQi90cCeSn9pjyhWaMqaF7ecD2");
  try {
    // rBxQi90cCeSn9pjyhWaMqaF7ecD2
    // const user = await signInWithEmailAndPassword(getFirebaseAdminAuth().auth(),email,password)
    // console.log(user)
    // const adminAuth = getFirebaseAdminAuth().auth();
    // const user = await adminAuth.getUser("tRdnCpagQ7aImn92CG8OSZK7zhz1");
    // const currentClaims = user.customClaims || {};
    // await adminAuth.setCustomUserClaims("tRdnCpagQ7aImn92CG8OSZK7zhz1", {
    //   ...currentClaims,
    //   roles: ["SYSTEM_ADMIN"],
    // });

    const user = getFirebaseAdminAuth()
      .auth()
      .updateUser("NgzATFIH1WXVkCt0X1acLeyV0hz1", { emailVerified: false });

    res.status(200).json({ message: "Ok", user });
  } catch (error) {
    res.status(500).json(error);
  }
};

export default login;
