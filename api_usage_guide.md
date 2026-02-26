# RAG Chat API – Integration Guide for UI Team

## Overview

The RAG Chat endpoint lets users ask natural-language questions about project diagrams. The system retrieves relevant diagram context and generates an AI-powered answer. It supports multi-turn conversations via `conversationId`.

---

## Endpoint

```
POST /api/v1/graphql
```

**Content-Type:** `application/json`

---

## Authentication

Every request must include a Firebase ID token in the `Authorization` header:

```
Authorization: Bearer <firebase_id_token>
```

---

## Step-by-Step Testing Flow

### Step 0 – Make Sure Diagrams Are Indexed

Before chatting, the project's diagrams must be indexed. You can trigger indexing with this REST call:

```
POST /api/v1/rag/index-project-diagrams
Content-Type: application/json
Authorization: Bearer <firebase_id_token>

{
  "projectId": "<your_project_id>"
}
```

You only need to do this **once per project** (or again if diagrams change). The response will tell you how many diagrams were indexed.

---

### Step 1 – First Message (Start a New Conversation)

Send a query **without** `conversationId`. The server will create a new conversation and return its ID.

**GraphQL Query:**

```graphql
query RagChat(
  $message: String!
  $projectId: ID!
  $conversationId: ID
  $maxChunks: Int
) {
  ragChat(
    message: $message
    projectId: $projectId
  ) {
    answer
    sources {
      documentId
      documentName
      pageNumber
      relevanceScore
      snippet
    }
    conversationId
    metadata {
      model
      chunksUsed
      processingTimeMs
      tokensUsed
    }
  }
}
```

**Variables:**

```json
{
  "message": "What is the FPS (Pricing Engine)?",
  "projectId": "c9cb3aa9-944b-4355-b8c1-eab6b5689bf4"
}
```

**Example Response:**

```json
{
  "data": {
    "ragChat": {
      "answer": "The FPS (Pricing Engine) is a component in the Order to Cash process that...",
      "sources": [
        {
          "documentId": "abc123",
          "documentName": "OTC Order to Cash",
          "pageNumber": null,
          "relevanceScore": 0.87,
          "snippet": "FPS Pricing Engine handles rate calculations..."
        }
      ],
      "conversationId": "67702779-ce2c-488b-8fe4-d9d12e9e9f85",
      "metadata": {
        "model": "meta-llama/llama-4-scout-17b-16e-instruct",
        "chunksUsed": 3,
        "processingTimeMs": 3426,
        "tokensUsed": 6709
      }
    }
  }
}
```

> **Important:** Save the `conversationId` from the response. You will need it for follow-up messages.

---

### Step 2 – Follow-Up Messages (Continue the Conversation)

To continue the same conversation (so the AI remembers previous messages), include the `conversationId` from Step 1.

**GraphQL Query:**

```graphql
query RagChat(
  $message: String!
  $projectId: ID!
  $conversationId: ID
  $maxChunks: Int
) {
  ragChat(
    message: $message
    projectId: $projectId
    conversationId: $conversationId
  ) {
    answer
    sources {
      documentId
      documentName
      pageNumber
      relevanceScore
      snippet
    }
    conversationId
    metadata {
      model
      chunksUsed
      processingTimeMs
      tokensUsed
    }
  }
}
```

**Variables:**

```json
{
  "message": "A major part of RightAngle ETRM",
  "projectId": "c9cb3aa9-944b-4355-b8c1-eab6b5689bf4",
  "conversationId": "67702779-ce2c-488b-8fe4-d9d12e9e9f85"
}
```

The response format is the same as Step 1. The `conversationId` will remain the same for all messages in that conversation.

---

### Step 3 – Start a New Conversation

To start a **fresh** conversation (no memory of previous messages), simply omit `conversationId` again — just like Step 1. The server will return a new `conversationId`.

---

## Optional Parameters

| Parameter        | Type     | Required | Description                                                     |
| ---------------- | -------- | -------- | --------------------------------------------------------------- |
| `message`        | `String` | Yes      | The user's question                                             |
| `projectId`      | `ID`     | Yes      | The project to search diagrams in                               |
| `conversationId` | `ID`     | No       | Include to continue an existing conversation; omit to start new |
| `maxChunks`      | `Int`    | No       | Max number of diagram chunks to retrieve (default handled by server) |

---

## Other Useful Queries

### Get All Conversations for a Project

```graphql
query {
  ragGetConversations(projectId: "c9cb3aa9-944b-4355-b8c1-eab6b5689bf4") {
    id
    projectId
    title
    createdAt
    updatedAt
    messageCount
  }
}
```

### Get Full Conversation History

```graphql
query {
  ragGetConversation(conversationId: "<conversation_id>") {
    id
    projectId
    title
    messages {
      role
      content
      timestamp
    }
  }
}
```

### Check Document Index Status

```graphql
query {
  ragGetDocumentStatus(projectId: "c9cb3aa9-944b-4355-b8c1-eab6b5689bf4") {
    documentId
    fileName
    status
    chunksCount
    lastIndexed
  }
}
```

### Search Documents (Without Chat)

```graphql
query {
  ragSearchDocuments(
    query: "pricing engine"
    projectId: "c9cb3aa9-944b-4355-b8c1-eab6b5689bf4"
  ) {
    documentId
    documentName
    snippet
    relevanceScore
  }
}
```

---

## Quick Checklist

1. **Get a Firebase token** for authentication.
2. **Index the project** (Step 0) — only once per project.
3. **Send first message** without `conversationId` → save the returned `conversationId`.
4. **Send follow-ups** with `conversationId` to maintain context.
5. **Omit `conversationId`** whenever you want to start fresh.

---

## Test Project IDs

| Project Name     | Project ID                                   | Notes                          |
| ---------------- | -------------------------------------------- | ------------------------------ |
| Copy Of MOT      | `c9cb3aa9-944b-4355-b8c1-eab6b5689bf4`      | 10 diagrams, already indexed   |
| CNC Machine Shop | `55448863-af9e-4ac6-b1ac-0decfdc4ce6f`       | 81 nodes, may need re-indexing |

---

## Notes

- The AI model used is **Llama 4 Scout** (via Groq). Response times are typically 2–5 seconds.
- Diagram embeddings use a local model served via ngrok. If the embedding service is down, indexing will fail.
- All queries go through the **same GraphQL endpoint** (`/api/v1/graphql`).


### My queries:
1. query RagChat(
  $message: String!
  $projectId: ID!
  $conversationId: ID
  $maxChunks: Int
) {
  ragChat(
    message: "What is the FPS (Pricing Engine)"
    projectId: "c9cb3aa9-944b-4355-b8c1-eab6b5689bf4"
  ) {
    answer
    sources {
      documentId
      documentName
      pageNumber
      relevanceScore
      snippet
    }
    conversationId
    metadata {
      model
      chunksUsed
      processingTimeMs
      tokensUsed
    }
  }
}

Response:
{
  "answer": "I couldn't find any information about the FPS (Pricing Engine) in the available documents. Let's try to search for it in the diagrams. \n\nWhich diagram might the FPS (Pricing Engine) be related to?",
  "sources": [],
  "conversationId": "67702779-ce2c-488b-8fe4-d9d12e9e9f85",
  "metadata": {
    "model": "meta-llama/llama-4-scout-17b-16e-instruct",
    "chunksUsed": 0,
    "processingTimeMs": 6100,
    "tokensUsed": 2929
  }
}


2. query RagChat(
  $message: String!
  $projectId: ID!
  $conversationId: ID
  $maxChunks: Int
) {
  ragChat(
    message: "A major part of RightAngle ETRM"
    projectId: "c9cb3aa9-944b-4355-b8c1-eab6b5689bf4"
    conversationId: "67702779-ce2c-488b-8fe4-d9d12e9e9f85"
  ) {
    answer
    sources {
      documentId
      documentName
      pageNumber
      relevanceScore
      snippet
    }
    conversationId
    metadata {
      model
      chunksUsed
      processingTimeMs
      tokensUsed
    }
  }
}


Response:
 {
  "answer": "Since I couldn't find any relevant information in the documents, let's try to search for it in the diagrams. \n\nI'll use the \"RightAngle ETRM\" as a search query to find a relevant diagram.\n\nThe \"Application Architecture\" seems to be related to ETRM systems.\n\nLet me retrieve the context of the \"Application Architecture\" diagram.",
  "sources": [],
  "conversationId": "67702779-ce2c-488b-8fe4-d9d12e9e9f85",
  "metadata": {
    "model": "meta-llama/llama-4-scout-17b-16e-instruct",
    "chunksUsed": 0,
    "processingTimeMs": 5262,
    "tokensUsed": 3077
  }
}


3. query RagChat(
  $message: String!
  $projectId: ID!
  $conversationId: ID
  $maxChunks: Int
) {
  ragChat(
    message: "Okay let me know"
    projectId: "c9cb3aa9-944b-4355-b8c1-eab6b5689bf4"
    conversationId: "67702779-ce2c-488b-8fe4-d9d12e9e9f85"
  ) {
    answer
    sources {
      documentId
      documentName
      pageNumber
      relevanceScore
      snippet
    }
    conversationId
    metadata {
      model
      chunksUsed
      processingTimeMs
      tokensUsed
    }
  }
}


Response:
 {
  "answer": "The FPS (Pricing Engine) appears to be a critical component of the RightAngle ETRM system. It seems to be connected to various other systems and processes, including:\n\n* RightAngle ETRM\n* TMS Host (TopHat)\n* SAP ERP\n* PEGA\n* Motive Salesforce\n* Load2Day\n* Market View\n* TTR\n\nThe FPS (Pricing Engine) seems to be involved in various pricing-related activities, such as:\n\n* Rack & Contract Price Notification (R1292)\n* Customer Formula Contract Price (R1301)\n* SBC-I-0053 Rack Prices (R1300)\n* SBC-I-0056 Rack Prices & Audit Message (R1294)\n* SBC-I-0057 Customer Formula Contract Price & Audit Message (R1295)\n\nIt also appears to be connected to other systems and processes, such as:\n\n* ETL (Extract, Transform, Load) processes\n* Data mart and reporting\n* Credit risk management\n\nThe FPS (Pricing Engine) seems to be a key component in managing pricing and risk for the RightAngle ETRM system.\n\nWould you like to know more about a specific aspect of the FPS (Pricing Engine) or its connections to other systems?",
  "sources": [
    {
      "documentId": "980799f4-11bc-439b-afa9-34d8746bf23f",
      "documentName": "Application Architecture",
      "pageNumber": 0,
      "relevanceScore": 1,
      "snippet": "Diagram: 264 nodes, 325 edges, 0 groups"
    }
  ],
  "conversationId": "67702779-ce2c-488b-8fe4-d9d12e9e9f85",
  "metadata": {
    "model": "meta-llama/llama-4-scout-17b-16e-instruct",
    "chunksUsed": 1,
    "processingTimeMs": 6038,
    "tokensUsed": 18878
  }
}