import { Request, Response } from "express";
import { getFirebaseAdminAuth } from "../../graphql/firebase/admin";

// 🔒 ONLY these emails will be kept
const ALLOWED_EMAILS = new Set([
  "revathiflonautics@gmail.com",
  "jeevika202301@gmail.com",
  "support@flonautics.com"
].map(e => e.toLowerCase()));

const login = async (req: Request, res: Response) => {
  try {
    const adminAuth = getFirebaseAdminAuth().auth();

    let nextPageToken: string | undefined = undefined;
    let updated = 0;
    let deleted = 0;

    do {
      const result = await adminAuth.listUsers(1000, nextPageToken);
      nextPageToken = result.pageToken;

      for (const user of result.users) {
        const email = (user.email ?? "").toLowerCase();

        if (email && ALLOWED_EMAILS.has(email)) {
          // ✅ Update claims
          await adminAuth.setCustomUserClaims(user.uid, {
            ...(user.customClaims ?? {}),
            orgCreated: false,
          });
          updated++;
        } else {
          // ❌ Delete everyone else
          await adminAuth.deleteUser(user.uid);
          deleted++;
        }
      }
    } while (nextPageToken);

    return res.status(200).json({
      message: "Completed",
      updatedUsers: updated,
      deletedUsers: deleted,
    });

  } catch (error: any) {
    return res.status(500).json({
      message: "Error processing users",
      error: error?.message ?? error,
    });
  }
};

export default login;
