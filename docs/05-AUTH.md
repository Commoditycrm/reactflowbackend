# Authentication & Authorization - Complete Guide

## 📋 Table of Contents
- [Overview](#overview)
- [Firebase Authentication](#firebase-authentication)
- [JWT Token Flow](#jwt-token-flow)
- [Authorization Patterns](#authorization-patterns)
- [Custom Claims & Roles](#custom-claims--roles)
- [GraphQL Authorization](#graphql-authorization)
- [Common Patterns](#common-patterns)

---

## Overview

This application uses **Firebase Authentication** for user identity and **GraphQL @authorization directives** for access control.

### Authentication vs Authorization

- **Authentication** = Who you are (Firebase)
- **Authorization** = What you can do (GraphQL schema)

---

## Firebase Authentication

### Setup: `src/graphql/firebase/admin.ts`

```typescript
import * as admin from "firebase-admin";
import { EnvLoader } from "../../util/EnvLoader";

let firebaseAdmin: admin.app.App | null = null;

export const getFirebaseAdminAuth = (): admin.app.App => {
  if (firebaseAdmin) return firebaseAdmin;

  const privateKey = EnvLoader.getOrThrow("FIREBASE_PRIVATE_KEY")
    .replace(/\\n/g, "\n");

  firebaseAdmin = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: EnvLoader.getOrThrow("FIREBASE_PROJECT_ID"),
      privateKey: privateKey,
      clientEmail: EnvLoader.getOrThrow("FIREBASE_CLIENT_EMAIL"),
    }),
  });

  return firebaseAdmin;
};
```

### Required Environment Variables

```env
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@your-project.iam.gserviceaccount.com
```

---

## JWT Token Flow

### 1. User Login (Client Side)

```typescript
// Client: Firebase Authentication
import { signInWithEmailAndPassword } from "firebase/auth";

const userCredential = await signInWithEmailAndPassword(
  auth,
  email,
  password
);

// Get ID token
const idToken = await userCredential.user.getIdToken();
```

### 2. Send Token to Server

```http
POST /api/v1/graphql
Authorization: Bearer <idToken>
Content-Type: application/json

{
  "query": "query { users { name } }"
}
```

### 3. Server Validates Token

**File: `src/graphql/init/neo.init.ts`**

```typescript
static async authorizeUserOnContext(req: Request) {
  // Extract token from Authorization header
  const token = getTokenFromHeader(req.headers.authorization);
  
  if (!token) {
    throw new GraphQLError("Authentication token is required", {
      extensions: { code: "UNAUTHENTICATED" }
    });
  }

  try {
    // Verify token with Firebase Admin SDK
    const decodedToken = await getFirebaseAdminAuth()
      .auth()
      .verifyIdToken(token, true);  // checkRevoked = true

    // Check email verification
    if (!decodedToken?.email_verified) {
      throw new GraphQLError("Please verify your email first.", {
        extensions: { code: "EMAIL_NOT_VERIFIED" }
      });
    }

    // Return JWT payload as context
    return { jwt: decodedToken };
    
  } catch (e: any) {
    if (e?.code === "auth/id-token-revoked") {
      throw new GraphQLError("Token has been revoked", {
        extensions: { code: "TOKEN_REVOKED" }
      });
    }
    throw e;
  }
}
```

### Token Extraction Helper

**File: `src/util/tokenExtractor.ts`**

```typescript
export const getTokenFromHeader = (
  authHeader: string | undefined
): string | null => {
  if (!authHeader) return null;
  
  // Format: "Bearer <token>"
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }
  
  return parts[1];
};
```

### 4. Context Available in GraphQL

```typescript
// In resolvers and @authorization directives
_context = {
  jwt: {
    sub: "firebase-uid-123",        // Firebase UID
    email: "user@example.com",
    email_verified: true,
    name: "John Doe",
    phone_number: "+1234567890",
    roles: ["SUPER_USER"],          // Custom claim
    // ... other Firebase claims
  }
}
```

---

## Custom Claims & Roles

### User Roles

**File: `src/interfaces/types.ts`**

```typescript
export enum UserRole {
  COMPANY_ADMIN = "COMPANY_ADMIN",   // Org owner
  SYSTEM_ADMIN = "SYSTEM_ADMIN",      // Platform admin
  ADMIN = "ADMIN",                     // Org admin
  SUPER_USER = "SUPER_USER",          // Power user
  USER = "USER"                        // Regular user
}
```

### Setting Custom Claims

**File: `src/graphql/firebase/firebaseFunctions.ts`**

```typescript
export class FirebaseFunctions {
  private static instance: FirebaseFunctions;
  private auth: admin.auth.Auth;

  static getInstance(): FirebaseFunctions {
    if (!FirebaseFunctions.instance) {
      const app = getFirebaseAdminAuth();
      FirebaseFunctions.instance = new FirebaseFunctions();
      FirebaseFunctions.instance.auth = app.auth();
    }
    return FirebaseFunctions.instance;
  }

  async setCustomUserClaims(
    uid: string,
    claims: Record<string, any>
  ): Promise<void> {
    const currentUser = await this.auth.getUser(uid);
    const currentClaims = currentUser.customClaims || {};
    
    await this.auth.setCustomUserClaims(uid, {
      ...currentClaims,
      ...claims
    });
  }

  async setUserRole(uid: string, role: UserRole): Promise<void> {
    await this.setCustomUserClaims(uid, { roles: [role] });
  }
}
```

### Example: Auto-Set Role on User Creation

**File: `src/graphql/callbacks/populatedByCallbacks.ts`**

```typescript
const userRoleSetter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const userRole = _context?.jwt?.roles[0];
  
  // If creating organization, make them COMPANY_ADMIN
  if (_parent?.ownedOrganization?.create) {
    return userRole === UserRole.SystemAdmin 
      ? userRole 
      : UserRole.CompanyAdmin;
  }
  
  // Otherwise, SUPER_USER
  return UserRole.SuperUser;
};
```

**In schema:**
```graphql
type User {
  role: String!
    @populatedBy(callback: "userRoleSetter", operations: [CREATE])
    @settable(onCreate: true, onUpdate: false)
}
```

### Retry Mechanism for Custom Claims

**File: `src/util/retrySetCustomClaims.ts`**

```typescript
const retrySetClaims = async (
  uid: string,
  claims: Record<string, any>,
  maxRetries = 3
): Promise<void> => {
  const firebaseFunctions = FirebaseFunctions.getInstance();
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await firebaseFunctions.setCustomUserClaims(uid, claims);
      logger?.info(`Custom claims set for ${uid} on attempt ${attempt}`);
      return;
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      // Exponential backoff: 1s, 2s, 4s
      await new Promise(resolve => 
        setTimeout(resolve, Math.pow(2, attempt) * 1000)
      );
    }
  }
};

export default retrySetClaims;
```

---

## GraphQL Authorization

### @authorization Directive

**Two modes:**

1. **filter** - Filter query results
2. **validate** - Throw error if unauthorized

### Filter Mode

**Automatically filter results:**

```graphql
type Organization
  @authorization(
    filter: [
      {
        operations: [READ, AGGREGATE]
        where: {
          OR: [
            { node: { deletedAt: null } }
            { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
          ]
        }
      }
    ]
  )
```

**Behavior:**
- Regular users only see non-deleted orgs
- SYSTEM_ADMIN sees all orgs (including deleted)
- No error thrown, just filtered results

### Validate Mode

**Throw error if unauthorized:**

```graphql
type User
  @authorization(
    validate: [
      {
        operations: [UPDATE]
        where: { node: { externalId: "$jwt.sub" } }
      }
    ]
  )
```

**Behavior:**
- User can UPDATE only their own record
- Throws `FORBIDDEN` error otherwise

### Authorization Variables

**Available in `where` clause:**

```graphql
$jwt.sub            # Firebase UID
$jwt.email          # User email
$jwt.roles          # Array of roles
$jwt.email_verified # Boolean
# ... any custom claim
```

### Common Patterns

**Pattern 1: Owner or Admin Access**

```graphql
@authorization(
  validate: [
    {
      operations: [UPDATE, DELETE]
      where: {
        node: {
          OR: [
            { organization: { createdBy: { externalId: "$jwt.sub" } } }
            {
              organization: {
                memberUsers_SINGLE: {
                  externalId: "$jwt.sub"
                  role: "ADMIN"
                }
              }
            }
          ]
        }
      }
    }
  ]
)
```

**Pattern 2: Self-Access Only**

```graphql
type User
  @authorization(
    validate: [
      { operations: [UPDATE], where: { node: { externalId: "$jwt.sub" } } }
    ]
  )
```

**Pattern 3: Role-Based Access**

```graphql
type Organization
  @authorization(
    validate: [
      {
        operations: [DELETE]
        where: { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
      }
    ]
  )
```

**Pattern 4: Membership Check**

```graphql
@authorization(
  validate: [
    {
      operations: [READ]
      where: {
        node: {
          organization: {
            OR: [
              { memberUsers_SOME: { externalId: "$jwt.sub" } }
              { createdBy: { externalId: "$jwt.sub" } }
            ]
          }
        }
      }
    }
  ]
)
```

**Pattern 5: Field-Level Authorization**

```graphql
type User {
  email: String!
  
  # Only the user themselves can see their phone number
  phoneNumber: String
    @authorization(
      validate: [{ where: { node: { externalId: "$jwt.sub" } } }]
    )
}
```

---

## Common Patterns

### Multi-Tenant Access Control

**Every query is scoped to user's organization:**

```typescript
// File: src/graphql/resolvers/read.resolvers.ts
export const getModelWhereClause = (
  modelName: string,
  loggedInUser: User
): Record<string, any> => {
  const commonOrgWhere = {
    organization: {
      id:
        loggedInUser?.ownedOrganization?.id ||
        loggedInUser?.memberOfOrganizations[0]?.id,
    },
  };

  switch (modelName) {
    case "Project":
      return { ...commonOrgWhere };
      
    case "BacklogItem":
      return {
        project: { ...commonOrgWhere }
      };
      
    // ... etc
  }
};
```

**Usage in resolver:**

```typescript
const getProjects = async (_source, _args, _context) => {
  const session = driver.session();
  
  // Get current user
  const User = await ogm.model("User");
  const [loggedInUser] = await User.find({
    where: { externalId: _context.jwt.sub },
    selectionSet: `{
      ownedOrganization { id }
      memberOfOrganizations { id }
    }`
  });

  // Build org-scoped where clause
  const where = getModelWhereClause("Project", loggedInUser);
  
  // Query with auto-filtering
  const Project = await ogm.model("Project");
  const projects = await Project.find({ where });
  
  return projects;
};
```

### Prevent Circular Dependencies

```typescript
// File: src/database/constants.ts
export const CONNECT_DEPENDENCY_CQL = `
  MATCH (dependent:BacklogItem {id: $dependentId})
  MATCH (dependency:BacklogItem {id: $dependencyId})
  
  # Authorization check (same org)
  MATCH (dependent)-[:ITEM_IN_PROJECT]->(:Project)-[:BELONGS_TO]->(org:Organization)
  MATCH (dependency)-[:ITEM_IN_PROJECT]->(:Project)-[:BELONGS_TO]->(org)
  
  # Prevent circular dependencies
  WHERE NOT EXISTS {
    MATCH path=(dependency)-[:DEPENDS_ON*]->(dependent)
  }
  
  MERGE (dependent)-[:DEPENDS_ON]->(dependency)
  RETURN dependent, dependency
`;
```

### Email Verification Check

**Already in context validation:**

```typescript
if (!decodedToken?.email_verified) {
  throw new GraphQLError("Please verify your email first.", {
    extensions: { code: "EMAIL_NOT_VERIFIED" }
  });
}
```

**Client must verify email before using API**

---

## Error Handling

### Authentication Errors

```typescript
{
  "errors": [{
    "message": "Authentication token is required",
    "extensions": {
      "code": "UNAUTHENTICATED"
    }
  }]
}
```

### Authorization Errors

```typescript
{
  "errors": [{
    "message": "Forbidden",
    "extensions": {
      "code": "FORBIDDEN"
    }
  }]
}
```

### Token Errors

```typescript
// Token expired
{
  "extensions": { "code": "TOKEN_EXPIRED" }
}

// Token revoked
{
  "extensions": { "code": "TOKEN_REVOKED" }
}

// Email not verified
{
  "extensions": { "code": "EMAIL_NOT_VERIFIED" }
}
```

---

## Testing Authorization

### Get Test Token

```typescript
// Use Firebase Auth emulator or real Firebase
import { signInWithEmailAndPassword } from "firebase/auth";

const userCredential = await signInWithEmailAndPassword(
  auth,
  "test@example.com",
  "password123"
);

const token = await userCredential.user.getIdToken();
console.log("Token:", token);
```

### Test in GraphQL Playground

1. Open http://localhost:4000/api/v1/graphql
2. Click "HTTP HEADERS" at bottom
3. Add:
```json
{
  "Authorization": "Bearer <your-token>"
}
```

### Test Different Roles

```typescript
// Set role to ADMIN
await firebaseFunctions.setUserRole(uid, UserRole.Admin);

// Get new token (old token still has old claims)
const newToken = await user.getIdToken(true);  // force refresh
```

---

## Security Best Practices

### 1. Always Validate Tokens

✅ Do:
```typescript
const decodedToken = await getFirebaseAdminAuth()
  .auth()
  .verifyIdToken(token, true);  // checkRevoked = true
```

❌ Don't:
```typescript
// Never trust client-provided claims without verification
const userId = req.body.userId;  // Dangerous!
```

### 2. Use Field-Level Authorization

```graphql
type User {
  publicProfile: String  # Anyone can see
  
  email: String
    @authorization(validate: [{ where: { node: { externalId: "$jwt.sub" } } }])
}
```

### 3. Filter by Organization

**Always scope queries to user's org:**

```typescript
const where = {
  organization: {
    id: loggedInUser.ownedOrganization?.id || 
        loggedInUser.memberOfOrganizations[0]?.id
  }
};
```

### 4. Use HTTPS in Production

```env
NODE_ENV=production
# Force HTTPS, secure cookies, etc.
```

### 5. Rate Limiting

```typescript
// Add rate limiting middleware (recommended)
import rateLimit from "express-rate-limit";

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100                    // 100 requests per window
});

app.use("/api", limiter);
```

---

## Summary

Authentication & Authorization provides:
- ✅ **Firebase Auth** - Industry-standard identity
- ✅ **JWT Tokens** - Stateless authentication
- ✅ **Custom Claims** - Role-based access
- ✅ **GraphQL @authorization** - Declarative security
- ✅ **Multi-tenancy** - Organization isolation
- ✅ **Field-level** - Granular permissions
