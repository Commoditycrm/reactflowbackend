# ReactFlow Backend - Complete Architecture Overview

## 📋 Table of Contents
- [System Overview](#system-overview)
- [Technology Stack](#technology-stack)
- [Architecture Patterns](#architecture-patterns)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Key Concepts](#key-concepts)
- [Documentation Index](#documentation-index)

---

## System Overview

This is a **GraphQL-based backend** for a project management application built with:
- **Neo4j Graph Database** (using Cypher query language)
- **Apollo Server** (GraphQL server)
- **Firebase Authentication** (user auth & authorization)
- **Express.js** (REST endpoints for auth, cron jobs, notifications)
- **TypeScript** (type-safe development)

### What Makes This Application Special?

1. **Graph Database (Neo4j)**: Perfect for managing complex relationships like:
   - Projects → Folders → Files → FlowNodes → BacklogItems
   - Users → Organizations → Projects
   - Tasks dependencies and hierarchies

2. **Code-First GraphQL**: The schema is defined using GraphQL SDL (Schema Definition Language) and automatically generates:
   - CRUD resolvers
   - Complex queries with filters
   - Real-time subscriptions
   - Authorization rules

3. **Multi-Tenant Architecture**: Each organization has isolated data with proper access controls

---

## Technology Stack

```json
{
  "Core": {
    "Runtime": "Node.js with TypeScript",
    "API": "GraphQL (Apollo Server v4)",
    "Database": "Neo4j Graph Database",
    "ORM": "@neo4j/graphql-ogm v5",
    "REST Framework": "Express.js"
  },
  "Authentication": {
    "Provider": "Firebase Admin SDK",
    "Strategy": "JWT tokens with custom claims"
  },
  "Communication": {
    "Email": "SendGrid",
    "WhatsApp": "Twilio"
  },
  "AI": {
    "Provider": "OpenAI GPT-4"
  },
  "Real-time": {
    "WebSockets": "graphql-ws",
    "Subscriptions": "GraphQL Subscriptions"
  }
}
```

### Dependencies Breakdown

**GraphQL & Database:**
```json
{
  "@apollo/server": "^4.12.2",          // GraphQL server
  "@neo4j/graphql": "^5.12.8",          // Neo4j GraphQL library
  "@neo4j/graphql-ogm": "^5.11.4",      // Object Graph Mapper
  "neo4j-driver": "^5.28.1",            // Neo4j database driver
  "graphql": "^16.11.0",                // GraphQL core
  "graphql-ws": "^5.16.2"               // WebSocket subscriptions
}
```

**External Services:**
```json
{
  "firebase-admin": "^11.11.0",         // Auth & user management
  "@sendgrid/mail": "^8.1.6",           // Email service
  "twilio": "^5.10.7",                  // WhatsApp messaging
  "openai": "^4.77.0"                   // AI integration
}
```

---

## Architecture Patterns

### 1. **Layered Architecture**

```
┌─────────────────────────────────────────────┐
│           HTTP Server (Express)             │
├─────────────────────────────────────────────┤
│  REST Routes        │    GraphQL Endpoint   │
│  /api/v1/auth      │    /api/v1/graphql    │
│  /api/v1/cron      │                       │
│  /api/v1/notify    │                       │
├─────────────────────┴───────────────────────┤
│         Apollo Server (GraphQL Layer)        │
│  - Schema validation                        │
│  - Authorization (@authorization)           │
│  - Field resolvers                          │
├─────────────────────────────────────────────┤
│    Neo4j GraphQL (Auto-generated Layer)     │
│  - CRUD operations                          │
│  - Cypher query generation                  │
│  - Relationship handling                    │
├─────────────────────────────────────────────┤
│          Custom Resolvers Layer             │
│  - Complex business logic                   │
│  - Custom Cypher queries                    │
│  - External API calls                       │
├─────────────────────────────────────────────┤
│            Neo4j Graph Database             │
│  - Nodes (Users, Projects, Files, etc.)    │
│  - Relationships (OWNS, MEMBER_OF, etc.)   │
└─────────────────────────────────────────────┘
```

### 2. **Singleton Pattern**

All service classes use the Singleton pattern to ensure single instances:

```typescript
// Example: EmailService
export class EmailService {
  private static instance: EmailService;
  
  private constructor() { /* initialization */ }
  
  static getInstance(): EmailService {
    if (!EmailService.instance) {
      EmailService.instance = new EmailService();
    }
    return EmailService.instance;
  }
}
```

**Used in:**
- `EmailService`
- `WhatsAppService`
- `Neo4JConnection`
- `OGMConnection`
- `FirebaseFunctions`

### 3. **Callback Pattern (populatedBy)**

Fields can auto-populate using callbacks during mutations:

```typescript
// In schema
email: String! @populatedBy(callback: "emailExtractor", operations: [CREATE])

// In callbacks
const emailExtractor = (_parent, _args, _context) => {
  return _context?.authorization?.jwt?.email;
};
```

---

## Quick Start

### Prerequisites
```bash
Node.js >= 18
Neo4j Database (local or cloud)
Firebase Project
SendGrid API Key
Twilio Account (for WhatsApp)
```

### Environment Variables
Create `.env` file:

```env
# Server
PORT=4000
NODE_ENV=development

# Neo4j
NEO4J_URI=neo4j://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password

# Firebase
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
FIREBASE_CLIENT_EMAIL=firebase-admin@...

# SendGrid
SENDGRID_API_KEY=SG.xxxxx
EMAIL_FROM=noreply@yourdomain.com

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=xxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

# OpenAI
OPENAI_API_KEY=sk-xxxxx

# URLs
CLIENT_URL=http://localhost:3000
ADMIN_PANEL_API=http://localhost:3001
API_URL=http://localhost:4000

# Feature Flags
GENERATE_OGM_TYPES=true
INIT_SCHEMA=true
```

### Installation & Run

```bash
# Install dependencies
yarn install

# Development mode (with hot reload)
yarn dev

# Build for production
yarn build

# Run production
yarn start
```

### Access Points

- **GraphQL Playground**: http://localhost:4000/api/v1/graphql
- **GraphQL Endpoint**: http://localhost:4000/api/v1/graphql
- **WebSocket (Subscriptions)**: ws://localhost:4000/api/graphql
- **REST Auth**: http://localhost:4000/api/v1/auth/*
- **Notifications**: http://localhost:4000/api/v1/notification/*

---

## Project Structure

```
src/
├── server.ts                 # Entry point - Express & HTTP server setup
├── env/
│   └── detector.ts          # Environment detection (dev/prod/test)
├── util/
│   ├── EnvLoader.ts         # Type-safe env variable loader
│   ├── tokenExtractor.ts    # JWT token extraction from headers
│   └── retrySetCustomClaims.ts
├── logger/
│   ├── index.ts             # Logger factory
│   ├── developmentLogger.ts # Dev logger (verbose)
│   └── productionLogger.ts  # Prod logger (JSON format)
├── database/
│   ├── connection.ts        # Neo4j driver connection (Singleton)
│   └── constants.ts         # Cypher query constants
├── graphql/
│   ├── schema/
│   │   └── schema.ts        # GraphQL Schema (SDL)
│   ├── init/
│   │   ├── neo.init.ts      # Neo4jGraphQL initialization
│   │   ├── ogm.init.ts      # OGM initialization
│   │   └── apollo.init.ts   # Apollo Server setup
│   ├── resolvers/
│   │   ├── create.resolvers.ts   # Custom CREATE mutations
│   │   ├── read.resolvers.ts     # Custom READ queries
│   │   ├── update.resolvers.ts   # Custom UPDATE mutations
│   │   └── delete.resolvers.ts   # Custom DELETE mutations
│   ├── callbacks/
│   │   └── populatedByCallbacks.ts  # Field population callbacks
│   ├── firebase/
│   │   ├── admin.ts               # Firebase Admin SDK
│   │   └── firebaseFunctions.ts   # Firebase helper functions
│   ├── middleware/
│   │   └── cors.ts                # CORS configuration
│   └── error/
│       └── error.formatter.ts     # GraphQL error formatting
├── routers/
│   ├── index.ts             # Main router
│   ├── apiRouters.ts        # API v1 router
│   ├── authRouters.ts       # Auth endpoints
│   ├── cronRouters.ts       # Cron job endpoints
│   ├── notificationRouter.ts
│   ├── organizationRouters.ts
│   ├── projectRouter.ts
│   └── backlogItemRouter.ts
├── controllers/
│   ├── auth/                # Authentication controllers
│   ├── cronJobs/            # Scheduled job controllers
│   └── notification/        # Notification controllers
├── services/
│   ├── EmailService.ts      # SendGrid email service
│   ├── WhatsAppServices.ts  # Twilio WhatsApp service
│   └── OrganizationEmailServices.ts
└── interfaces/
    ├── types.ts             # TypeScript type definitions
    ├── ogm.types.ts         # Auto-generated OGM types
    └── graphql.d.ts         # GraphQL type extensions
```

---

## Key Concepts

### 1. **Graph Database (Neo4j)**

Instead of tables and rows, Neo4j stores data as:

- **Nodes**: Entities (User, Project, BacklogItem)
- **Relationships**: Connections between nodes (OWNS, MEMBER_OF, HAS_CHILD)
- **Properties**: Data on nodes/relationships

**Example in Cypher:**
```cypher
// Find all projects for a user
MATCH (u:User {externalId: "uid123"})-[:MEMBER_OF]->(org:Organization)
      <-[:BELONGS_TO]-(p:Project)
WHERE p.deletedAt IS NULL
RETURN p
```

### 2. **GraphQL Schema-First**

The entire API is defined in `schema.ts` using GraphQL SDL:

```graphql
type User {
  id: ID!
  name: String!
  email: String!
  ownedOrganization: Organization @relationship(type: "OWNS", direction: OUT)
  memberOfOrganizations: [Organization!]! @relationship(type: "MEMBER_OF", direction: OUT)
}
```

**Auto-generated operations:**
- `users` query
- `createUsers` mutation
- `updateUsers` mutation
- `deleteUsers` mutation

### 3. **Authorization with @authorization**

Field-level and operation-level authorization:

```graphql
type User @authorization(
  validate: [
    {
      operations: [UPDATE]
      where: { node: { externalId: "$jwt.sub" } }
    }
  ]
)
```

This means: "Users can only UPDATE their own record"

### 4. **Soft Delete Pattern**

All entities implement `SoftDeletable`:

```graphql
interface SoftDeletable {
  deletedAt: DateTime
}
```

Instead of deleting, set `deletedAt` timestamp. Queries automatically filter out soft-deleted items.

### 5. **Multi-Tenancy**

Each organization is isolated:
- Users belong to organizations via `OWNS` or `MEMBER_OF`
- All data queries are scoped to the user's organization
- Authorization checks ensure data isolation

---

## Documentation Index

### Core Documentation
1. **[GraphQL Concepts & Setup](./docs/01-GRAPHQL-CONCEPTS.md)** - Start here if new to GraphQL
2. **[Neo4j & Cypher Database Guide](./docs/02-NEO4J-CYPHER.md)** - Understanding the graph database
3. **[Schema & Type System](./docs/03-SCHEMA-TYPES.md)** - Complete schema documentation
4. **[Resolvers & Custom Logic](./docs/04-RESOLVERS.md)** - Custom business logic

### Feature Documentation
5. **[Authentication & Authorization](./docs/05-AUTH.md)** - Firebase auth, JWT, permissions
6. **[Services (Email, WhatsApp)](./docs/06-SERVICES.md)** - External service integrations
7. **[Controllers & REST Routes](./docs/07-CONTROLLERS-ROUTES.md)** - REST endpoints
8. **[Utilities & Helpers](./docs/08-UTILITIES.md)** - Helper functions and utilities

### Advanced Topics
9. **[Real-time with Subscriptions](./docs/09-SUBSCRIPTIONS.md)** - WebSocket subscriptions
10. **[Cron Jobs & Background Tasks](./docs/10-CRON-JOBS.md)** - Scheduled operations
11. **[Error Handling & Logging](./docs/11-ERROR-HANDLING.md)** - Error management
12. **[Testing Guide](./docs/12-TESTING.md)** - How to test the application

### For AI Bot Implementation
13. **[AI Bot Integration Guide](./docs/13-AI-BOT-INTEGRATION.md)** - Adding AI capabilities
14. **[Extending the Schema](./docs/14-EXTENDING-SCHEMA.md)** - Adding new types & resolvers

---

## Common Development Workflows

### Adding a New GraphQL Type

1. Define type in `schema.ts`
2. Add callbacks if needed in `populatedByCallbacks.ts`
3. Add custom resolvers if needed
4. Regenerate types: `yarn dev` (auto-generates)

### Adding a New REST Endpoint

1. Create controller in `controllers/`
2. Add route in appropriate router
3. Add to main router in `apiRouters.ts`

### Modifying Authorization Rules

1. Update `@authorization` directive in schema
2. Test with different user roles
3. Update tests

---

## Performance Considerations

### Neo4j Optimizations
- **Indexes**: Auto-created on `@id` and `@unique` fields
- **Connection Pooling**: 100 max connections
- **Fetch Size**: 2000 records per query
- **Timeouts**: 60s acquisition, 30s connection

### GraphQL Optimizations
- **DataLoader**: Batches and caches requests (built-in with @neo4j/graphql)
- **Field Selection**: Only queries requested fields
- **Pagination**: Use `@limit` directive

### Server Optimizations
- **Keep-Alive**: 65s timeout for connection reuse
- **Compression**: Built into Neo4j driver
- **JSON Parsing**: Express.json() middleware

---

## Troubleshooting

### GraphQL Errors
- Check authorization rules
- Verify JWT token
- Check field permissions

### Database Connection Issues
- Verify Neo4j is running
- Check credentials
- Test with Cypher Shell

### Authentication Failures
- Verify Firebase credentials
- Check token expiration
- Validate custom claims

---

## Next Steps

1. **Read [GraphQL Concepts](./docs/01-GRAPHQL-CONCEPTS.md)** for GraphQL fundamentals
2. **Read [Neo4j Guide](./docs/02-NEO4J-CYPHER.md)** for Cypher query language
3. **Study [Schema Documentation](./docs/03-SCHEMA-TYPES.md)** to understand data model
4. **Review [AI Bot Integration](./docs/13-AI-BOT-INTEGRATION.md)** for your AI module

---

## Contributing

When adding new features:
1. Follow existing patterns (Singleton, layered architecture)
2. Add proper TypeScript types
3. Include authorization rules
4. Add error handling
5. Update documentation

---

## License

MIT

---

**Need Help?** Check the detailed documentation in `/docs` folder for in-depth explanations of each component.
