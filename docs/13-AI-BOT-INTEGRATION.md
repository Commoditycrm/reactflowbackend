# AI Bot Integration Guide - Complete Implementation

## 📋 Table of Contents
- [Overview](#overview)
- [Current AI Integration](#current-ai-integration)
- [Architecture for AI Bot](#architecture-for-ai-bot)
- [Implementation Steps](#implementation-steps)
- [Example: Task Generation Bot](#example-task-generation-bot)
- [Example: Chat Bot](#example-chat-bot)
- [Example: Smart Assistant](#example-smart-assistant)
- [Best Practices](#best-practices)
- [Deployment](#deployment)

---

## Overview

This guide will help you integrate an AI bot module into the existing codebase. The system already has OpenAI integration for task generation - we'll expand on this to create a comprehensive AI bot system.

### What's Already Available

✅ OpenAI SDK configured  
✅ Task generation with GPT-4  
✅ Organization-aware context  
✅ User authentication  
✅ Real-time subscriptions (WebSocket)  

### What We'll Build

- 🤖 Conversational AI bot
- 💬 Context-aware responses
- 📊 Data analysis capabilities
- 🔄 Real-time chat
- 📝 Project insights
- 🎯 Smart recommendations

---

## Current AI Integration

### Existing Implementation

**File: `src/graphql/resolvers/read.resolvers.ts`**

```typescript
import OpenAI from "openai";
import { EnvLoader } from "../../util/EnvLoader";

const generateTask = async (
  _source: Record<string, any>,
  { prompt }: { prompt: string },
  _context: Record<string, any>
): Promise<GeneratedTask[]> => {
  const openai = new OpenAI({ 
    apiKey: EnvLoader.getOrThrow("OPENAI_API_KEY") 
  });
  
  const uid = _context?.jwt?.uid;
  const session = driver.session();

  try {
    // 1. Fetch organization-specific data (BacklogItemTypes)
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (u:User {externalId:$uid})-[:OWNS|MEMBER_OF]->(org:Organization)
        MATCH (org)-[:HAS_BACKLOGITEM_TYPE]->(t:BacklogItemType)
        RETURN t { .* } AS type
      `, { uid })
    );

    const orgTypes = result.records.map(r => r.get("type"));
    
    // 2. Match type from prompt
    const matchedType = orgTypes.find(t => 
      prompt.toLowerCase().includes(t.name.toLowerCase())
    );

    // 3. Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant. Generate tasks..."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 1000,
    });

    // 4. Parse and return results
    const tasksRaw = completion.choices[0]?.message?.content || "";
    return parseTasks(tasksRaw, matchedType);
    
  } finally {
    await session.close();
  }
};
```

**In Schema:**
```graphql
type Query {
  generateTasksWithAI(prompt: String!): [GeneratedTask!]!
}

type GeneratedTask {
  id: ID!
  label: String!
  description: String!
  type: BacklogItemType
}
```

**Usage:**
```graphql
query {
  generateTasksWithAI(prompt: "Create a bug tracking system") {
    label
    description
    type { name }
  }
}
```

---

## Architecture for AI Bot

### Proposed Structure

```
src/
├── ai/                          # NEW: AI module
│   ├── bot/
│   │   ├── AIBot.ts            # Main bot class
│   │   ├── context.ts           # Context builder
│   │   └── prompts.ts           # System prompts
│   ├── services/
│   │   ├── OpenAIService.ts    # Abstraction over OpenAI
│   │   ├── EmbeddingService.ts # Vector embeddings
│   │   └── RAGService.ts       # Retrieval Augmented Generation
│   ├── handlers/
│   │   ├── taskHandler.ts      # Task-related queries
│   │   ├── projectHandler.ts   # Project insights
│   │   ├── analyticsHandler.ts # Data analysis
│   │   └── chatHandler.ts      # General conversation
│   ├── memory/
│   │   ├── ConversationMemory.ts # Store chat history
│   │   └── VectorStore.ts       # Embeddings storage
│   └── types/
│       ├── bot.types.ts
│       └── handlers.types.ts
├── graphql/
│   ├── schema/
│   │   └── schema.ts           # Add AI bot types
│   └── resolvers/
│       └── ai.resolvers.ts     # NEW: AI resolvers
└── services/
    └── AIBotService.ts         # NEW: Singleton service
```

---

## Implementation Steps

### Step 1: Create AI Bot Service

**File: `src/services/AIBotService.ts`**

```typescript
import OpenAI from "openai";
import { EnvLoader } from "../util/EnvLoader";
import logger from "../logger";

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIBotConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export class AIBotService {
  private static instance: AIBotService;
  private openai: OpenAI;
  private defaultConfig: AIBotConfig;

  private constructor() {
    this.openai = new OpenAI({
      apiKey: EnvLoader.getOrThrow("OPENAI_API_KEY"),
    });

    this.defaultConfig = {
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 2000,
      systemPrompt: `You are an AI assistant for a project management system.
You have access to:
- Projects, tasks (BacklogItems), files, folders
- User information and assignments
- Sprint planning data
- Project analytics

Provide helpful, context-aware responses based on the user's data.
Be concise and actionable.`
    };
  }

  static getInstance(): AIBotService {
    if (!AIBotService.instance) {
      AIBotService.instance = new AIBotService();
    }
    return AIBotService.instance;
  }

  /**
   * Send a chat message with conversation history
   */
  async chat(
    messages: AIMessage[],
    config?: Partial<AIBotConfig>
  ): Promise<string> {
    const finalConfig = { ...this.defaultConfig, ...config };

    try {
      const completion = await this.openai.chat.completions.create({
        model: finalConfig.model!,
        messages: [
          { role: "system", content: finalConfig.systemPrompt! },
          ...messages
        ],
        temperature: finalConfig.temperature,
        max_tokens: finalConfig.maxTokens,
      });

      const response = completion.choices[0]?.message?.content || "";
      logger?.info("AI Bot response generated", {
        inputLength: messages.length,
        outputLength: response.length
      });

      return response;

    } catch (error) {
      logger?.error("AI Bot error:", error);
      throw new Error("Failed to generate AI response");
    }
  }

  /**
   * Generate embeddings for text (for RAG/similarity search)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      });

      return response.data[0].embedding;
    } catch (error) {
      logger?.error("Embedding generation error:", error);
      throw error;
    }
  }

  /**
   * Analyze text with specific instructions
   */
  async analyze(
    text: string,
    instructions: string
  ): Promise<string> {
    return this.chat([
      { role: "user", content: `${instructions}\n\nText to analyze:\n${text}` }
    ]);
  }

  /**
   * Stream responses (for real-time chat)
   */
  async *chatStream(
    messages: AIMessage[],
    config?: Partial<AIBotConfig>
  ): AsyncGenerator<string, void, unknown> {
    const finalConfig = { ...this.defaultConfig, ...config };

    const stream = await this.openai.chat.completions.create({
      model: finalConfig.model!,
      messages: [
        { role: "system", content: finalConfig.systemPrompt! },
        ...messages
      ],
      temperature: finalConfig.temperature,
      max_tokens: finalConfig.maxTokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        yield content;
      }
    }
  }
}
```

### Step 2: Add Context Builder

**File: `src/ai/bot/context.ts`**

```typescript
import { OGMConnection } from "../../graphql/init/ogm.init";
import { User } from "../../interfaces";

export interface UserContext {
  user: User;
  organization: {
    id: string;
    name: string;
  };
  projects: Array<{
    id: string;
    name: string;
    taskCount: number;
  }>;
  recentActivity: string[];
}

export class AIContextBuilder {
  /**
   * Build rich context about user and their data
   */
  static async buildUserContext(uid: string): Promise<UserContext> {
    const ogm = await OGMConnection.getInstance();
    const User = ogm.model("User");

    // Fetch user with organization and projects
    const [user] = await User.find<User[]>({
      where: { externalId: uid },
      selectionSet: `{
        id
        name
        email
        role
        ownedOrganization {
          id
          name
        }
        memberOfOrganizations {
          id
          name
          projects {
            id
            name
          }
        }
      }`
    });

    if (!user) {
      throw new Error("User not found");
    }

    const org = user.ownedOrganization || user.memberOfOrganizations[0];
    const projects = org?.projects || [];

    // Get task counts for each project
    const projectsWithCounts = await Promise.all(
      projects.map(async (project) => {
        const BacklogItem = ogm.model("BacklogItem");
        const items = await BacklogItem.find({
          where: {
            project: { id: project.id },
            deletedAt: null
          }
        });

        return {
          id: project.id,
          name: project.name,
          taskCount: items.length
        };
      })
    );

    return {
      user,
      organization: {
        id: org.id,
        name: org.name
      },
      projects: projectsWithCounts,
      recentActivity: [] // TODO: Implement activity tracking
    };
  }

  /**
   * Convert context to natural language for AI
   */
  static contextToPrompt(context: UserContext): string {
    return `
**User Information:**
- Name: ${context.user.name}
- Role: ${context.user.role}
- Organization: ${context.organization.name}

**Projects:**
${context.projects.map(p => 
  `- ${p.name} (${p.taskCount} tasks)`
).join('\n')}

Use this context to provide personalized, relevant responses.
    `.trim();
  }
}
```

### Step 3: Create GraphQL Schema

**Add to `src/graphql/schema/schema.ts`:**

```graphql
# AI Bot Types
type AIMessage {
  role: String!
  content: String!
  timestamp: DateTime!
}

type AIConversation {
  id: ID!
  user: User!
  messages: [AIMessage!]!
  createdAt: DateTime!
  updatedAt: DateTime
}

type AIChatResponse {
  message: String!
  suggestions: [String!]
  metadata: AIResponseMetadata
}

type AIResponseMetadata {
  model: String
  tokensUsed: Int
  processingTime: Float
}

type AIInsight {
  type: String!
  title: String!
  description: String!
  priority: Int
  actionable: Boolean!
}

input AIMessageInput {
  role: String!
  content: String!
}

type Query {
  # Existing
  generateTasksWithAI(prompt: String!): [GeneratedTask!]!
  
  # New AI Bot Queries
  aiChat(
    message: String!
    conversationId: ID
    context: String
  ): AIChatResponse!
  
  aiAnalyzeProject(projectId: ID!): [AIInsight!]!
  
  aiSuggestTasks(
    projectId: ID!
    context: String
  ): [GeneratedTask!]!
  
  aiGetConversation(conversationId: ID!): AIConversation
  
  aiGetConversations(limit: Int = 10): [AIConversation!]!
}

type Mutation {
  aiStartConversation(message: String!): AIConversation!
  
  aiContinueConversation(
    conversationId: ID!
    message: String!
  ): AIConversation!
  
  aiClearConversation(conversationId: ID!): Boolean!
}

type Subscription {
  aiChatStream(conversationId: ID!): String!
}
```

### Step 4: Create Resolvers

**File: `src/graphql/resolvers/ai.resolvers.ts`**

```typescript
import { AIBotService, AIMessage } from "../../services/AIBotService";
import { AIContextBuilder } from "../../ai/bot/context";
import { OGMConnection } from "../init/ogm.init";
import { v4 as uuidv4 } from "uuid";
import logger from "../../logger";

const aiBotService = AIBotService.getInstance();

// In-memory conversation storage (use Redis or DB in production)
const conversations = new Map<string, AIMessage[]>();

/**
 * AI Chat - Single message with optional conversation history
 */
const aiChat = async (
  _source: any,
  { message, conversationId, context }: {
    message: string;
    conversationId?: string;
    context?: string;
  },
  _context: any
) => {
  const startTime = Date.now();
  const uid = _context.jwt.sub;

  try {
    // Build user context
    const userContext = await AIContextBuilder.buildUserContext(uid);
    const contextPrompt = AIContextBuilder.contextToPrompt(userContext);

    // Get or create conversation
    const convId = conversationId || uuidv4();
    let messages = conversations.get(convId) || [];

    // Add user message
    const userMessage: AIMessage = {
      role: "user",
      content: message
    };
    messages.push(userMessage);

    // Generate response
    const systemContext = `${contextPrompt}\n\n${context || ""}`;
    const response = await aiBotService.chat(messages, {
      systemPrompt: systemContext
    });

    // Add assistant response
    const assistantMessage: AIMessage = {
      role: "assistant",
      content: response
    };
    messages.push(assistantMessage);

    // Store conversation
    conversations.set(convId, messages);

    const processingTime = (Date.now() - startTime) / 1000;

    return {
      message: response,
      suggestions: generateSuggestions(response),
      metadata: {
        model: "gpt-4o-mini",
        tokensUsed: estimateTokens(message + response),
        processingTime
      }
    };

  } catch (error) {
    logger?.error("AI Chat error:", error);
    throw new Error("Failed to process AI chat request");
  }
};

/**
 * Analyze project and provide insights
 */
const aiAnalyzeProject = async (
  _source: any,
  { projectId }: { projectId: string },
  _context: any
) => {
  const ogm = await OGMConnection.getInstance();
  const Project = ogm.model("Project");
  const BacklogItem = ogm.model("BacklogItem");

  // Fetch project with all tasks
  const [project] = await Project.find({
    where: { id: projectId },
    selectionSet: `{
      name
      description
      backlogItems {
        label
        status { name }
        type { name }
        assignedUser { name }
        startDate
        endDate
      }
    }`
  });

  if (!project) {
    throw new Error("Project not found");
  }

  // Prepare data for AI
  const projectSummary = `
Project: ${project.name}
Description: ${project.description || "N/A"}

Tasks (${project.backlogItems.length}):
${project.backlogItems.map((task, i) => `
  ${i + 1}. ${task.label}
     Status: ${task.status.name}
     Type: ${task.type.name}
     Assigned: ${task.assignedUser?.map(u => u.name).join(", ") || "Unassigned"}
     Timeline: ${task.startDate || "N/A"} - ${task.endDate || "N/A"}
`).join("\n")}
  `.trim();

  // Ask AI to analyze
  const analysis = await aiBotService.analyze(
    projectSummary,
    `Analyze this project and provide:
1. Overall health assessment
2. Potential risks or bottlenecks
3. Resource allocation issues
4. Timeline concerns
5. Actionable recommendations

Format as JSON array of insights with: type, title, description, priority (1-5), actionable (boolean)`
  );

  // Parse AI response
  try {
    const insights = JSON.parse(analysis);
    return insights;
  } catch (error) {
    logger?.error("Failed to parse AI insights:", error);
    return [{
      type: "general",
      title: "Project Analysis",
      description: analysis,
      priority: 3,
      actionable: true
    }];
  }
};

/**
 * Smart task suggestions based on project context
 */
const aiSuggestTasks = async (
  _source: any,
  { projectId, context }: { projectId: string; context?: string },
  _context: any
) => {
  const ogm = await OGMConnection.getInstance();
  const Project = ogm.model("Project");

  const [project] = await Project.find({
    where: { id: projectId },
    selectionSet: `{
      name
      description
      backlogItems {
        label
        description
      }
    }`
  });

  if (!project) {
    throw new Error("Project not found");
  }

  const prompt = `
Project: ${project.name}
Description: ${project.description || "N/A"}

Existing tasks:
${project.backlogItems.map(t => `- ${t.label}`).join("\n")}

${context || ""}

Based on the above, suggest 5-10 additional tasks that would be valuable.
Format: Task: <name> | Description: <description>
  `.trim();

  const response = await aiBotService.chat([
    { role: "user", content: prompt }
  ]);

  // Parse tasks (reuse existing parser from generateTask)
  const tasks = parseTasks(response);
  
  return tasks;
};

// Helper functions
function generateSuggestions(response: string): string[] {
  // Simple keyword-based suggestions
  const suggestions = [];
  
  if (response.toLowerCase().includes("task")) {
    suggestions.push("Show me my tasks");
  }
  if (response.toLowerCase().includes("project")) {
    suggestions.push("List all projects");
  }
  suggestions.push("What's my schedule?");
  suggestions.push("Show project insights");
  
  return suggestions.slice(0, 3);
}

function estimateTokens(text: string): number {
  // Rough estimation: 1 token ≈ 4 characters
  return Math.ceil(text.length / 4);
}

function parseTasks(response: string): any[] {
  const lines = response.split("\n");
  const tasks = [];
  
  for (const line of lines) {
    const match = line.match(/Task:\s*(.+?)\s*\|\s*Description:\s*(.+)/i);
    if (match) {
      tasks.push({
        id: uuidv4(),
        label: match[1].trim(),
        description: match[2].trim()
      });
    }
  }
  
  return tasks;
}

// Export resolvers
export const aiResolvers = {
  Query: {
    aiChat,
    aiAnalyzeProject,
    aiSuggestTasks,
  },
  Mutation: {
    // TODO: Implement mutations
  },
  Subscription: {
    // TODO: Implement real-time streaming
  }
};
```

### Step 5: Register Resolvers

**Update `src/graphql/init/neo.init.ts`:**

```typescript
import { aiResolvers } from "../resolvers/ai.resolvers";

static getResolvers(): IResolvers {
  return {
    Query: {
      ...readOperationQueries,
      ...aiResolvers.Query,  // Add AI resolvers
    },
    Mutation: {
      ...createOperationMutations,
      ...updateOperationMutations,
      ...deleteOperationMutations,
      ...aiResolvers.Mutation,  // Add AI mutations
    },
    Subscription: {
      ...aiResolvers.Subscription,  // Add AI subscriptions
    }
  };
}
```

---

## Example Use Cases

### Use Case 1: Project Insights

```graphql
query AnalyzeMyProject {
  aiAnalyzeProject(projectId: "proj-123") {
    type
    title
    description
    priority
    actionable
  }
}
```

**Response:**
```json
{
  "data": {
    "aiAnalyzeProject": [
      {
        "type": "risk",
        "title": "Resource Bottleneck",
        "description": "User 'John' is assigned to 15 tasks, while others have 2-3. Consider redistributing work.",
        "priority": 4,
        "actionable": true
      },
      {
        "type": "timeline",
        "title": "Overlapping Deadlines",
        "description": "5 critical tasks all due next week. Consider extending or deprioritizing.",
        "priority": 5,
        "actionable": true
      }
    ]
  }
}
```

### Use Case 2: Conversational Assistant

```graphql
query ChatWithBot {
  aiChat(
    message: "What tasks am I behind on?"
    context: "User is asking about overdue tasks"
  ) {
    message
    suggestions
    metadata {
      processingTime
    }
  }
}
```

**Response:**
```json
{
  "data": {
    "aiChat": {
      "message": "You have 3 overdue tasks:\n1. Fix login bug (due 3 days ago)\n2. Update documentation (due yesterday)\n3. Code review (due today)\n\nWould you like me to prioritize them for you?",
      "suggestions": [
        "Show me my tasks",
        "Prioritize my work",
        "Show project insights"
      ],
      "metadata": {
        "processingTime": 1.234
      }
    }
  }
}
```

### Use Case 3: Smart Task Generation

```graphql
query SuggestTasks {
  aiSuggestTasks(
    projectId: "proj-123"
    context: "We need to prepare for launch"
  ) {
    label
    description
  }
}
```

---

## Best Practices

### 1. Rate Limiting

```typescript
// Add to AIBotService
private requestCounts = new Map<string, number>();

async chat(messages: AIMessage[], config?: Partial<AIBotConfig>): Promise<string> {
  const userId = getCurrentUserId(); // from context
  
  // Rate limit: 10 requests per minute
  const count = this.requestCounts.get(userId) || 0;
  if (count >= 10) {
    throw new Error("Rate limit exceeded. Please wait a minute.");
  }
  
  this.requestCounts.set(userId, count + 1);
  setTimeout(() => this.requestCounts.delete(userId), 60000);
  
  // ... rest of implementation
}
```

### 2. Token Management

```typescript
// Estimate and enforce token limits
function enforceTokenLimit(messages: AIMessage[], maxTokens: number = 4000): AIMessage[] {
  let totalTokens = 0;
  const filtered: AIMessage[] = [];
  
  // Keep most recent messages within limit
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i].content);
    if (totalTokens + tokens > maxTokens) break;
    
    filtered.unshift(messages[i]);
    totalTokens += tokens;
  }
  
  return filtered;
}
```

### 3. Error Handling

```typescript
try {
  const response = await aiBotService.chat(messages);
  return response;
} catch (error) {
  if (error.code === "insufficient_quota") {
    return "I'm currently unavailable. Please try again later.";
  }
  if (error.code === "rate_limit_exceeded") {
    return "Too many requests. Please wait a moment.";
  }
  throw error;
}
```

### 4. Caching

```typescript
// Cache common queries
const cache = new Map<string, { response: string; timestamp: number }>();

async chat(messages: AIMessage[]): Promise<string> {
  const cacheKey = JSON.stringify(messages);
  const cached = cache.get(cacheKey);
  
  // Return cached if less than 1 hour old
  if (cached && Date.now() - cached.timestamp < 3600000) {
    return cached.response;
  }
  
  const response = await this.openai.chat.completions.create({...});
  
  cache.set(cacheKey, {
    response: response.choices[0].message.content,
    timestamp: Date.now()
  });
  
  return response.choices[0].message.content;
}
```

---

## Summary

You now have:
- ✅ **AI Bot Service** - Reusable OpenAI wrapper
- ✅ **Context Builder** - User-aware AI responses
- ✅ **GraphQL Integration** - Query & mutation support
- ✅ **Multiple Use Cases** - Chat, insights, task generation
- ✅ **Best Practices** - Rate limiting, caching, error handling

**Next Steps:**
1. Implement conversation persistence (use Neo4j or Redis)
2. Add real-time streaming with subscriptions
3. Implement RAG (Retrieval Augmented Generation) for better context
4. Add function calling for actions (create tasks, update status, etc.)
5. Build UI for chat interface

This provides a solid foundation for building sophisticated AI capabilities into your project management system!
