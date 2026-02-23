require('dotenv').config();
const admin = require('firebase-admin');

const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const generateToken = async (uid) => {
  try {
    const customToken = await admin.auth().createCustomToken(uid);
    
    console.log('\n✅ Custom token created successfully!\n');
    console.log('Custom Token:', customToken);
    console.log('\n📋 To get an ID token, run this command:\n');
    console.log(`curl -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=YOUR_FIREBASE_WEB_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"token":"${customToken}","returnSecureToken":true}'\n`);
    console.log('⚠️  You need to get your Firebase Web API Key from:');
    console.log('   Firebase Console → Project Settings → General → Web API Key\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
  
  process.exit(0);
};

// Get UID from command line or use default
const uid = process.argv[2];

if (!uid) {
  console.log('\n⚠️  Usage: node generate-test-token.js <USER_UID>\n');
  console.log('Example: node generate-test-token.js test-user-123\n');
  console.log('💡 Fetching a real user from Firebase...\n');
  
  // Try to list users and pick one
  admin.auth().listUsers(1)
    .then(result => {
      if (result.users.length > 0) {
        const user = result.users[0];
        console.log(`Found user: ${user.email} (UID: ${user.uid})\n`);
        generateToken(user.uid);
      } else {
        console.log('❌ No users found in Firebase. Creating token for test UID...\n');
        generateToken('test-user-development');
      }
    })
    .catch(() => {
      console.log('Using development test UID...\n');
      generateToken('test-user-development');
    });
} else {
  generateToken(uid);
}
