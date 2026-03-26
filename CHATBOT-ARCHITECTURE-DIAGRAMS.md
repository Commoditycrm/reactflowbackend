# Chatbot Architecture Diagrams (RAG + Graph-RAG + Agentic)

This document provides intuitive and implementation-aligned architecture diagrams for your chatbot stack.

Scope covered:
- Document RAG (PDF/Text retrieval + grounded answer generation)
- Graph-RAG (diagram/flow retrieval from Neo4j graph structures)
- Agentic behavior (tool routing, retries, fallback, quality gates)
- One major combined end-to-end architecture flow

---

## 1. High-Level System Context

```mermaid
flowchart LR
    U[User] --> FE[React Flow Frontend\nGraphQL askAi calls]
    FE --> AUTH[Firebase JWT Auth]
    AUTH --> API[Backend API Layer\nGraphQL + REST]

    API --> ORCH[RAGService Orchestrator\nAgentic loop + conversation state]

    ORCH --> DOC_RAG[Document RAG Path]
    ORCH --> GRAPH_RAG[Graph-RAG Path]

    DOC_RAG --> VS[(Neo4j Vector Index\nDocumentChunk embeddings)]
    GRAPH_RAG --> DG[(Neo4j Graph Data\nFlowNode / GroupNode / LINKED_TO)]
    GRAPH_RAG --> DS[(Diagram Summary Vector Index)]

    ORCH --> LLM[LLM Chat Model - final synthesis]
    DOC_RAG --> EMB["Embedding Model\n(query/chunk vectors)"]
    GRAPH_RAG --> EMB

    LLM --> API --> FE --> U
```

Why this matters:
- `RAGService` is the central orchestrator that decides whether to query documents, diagrams, or both.
- Retrieval is split into two specialized knowledge channels:
  - Document semantics (`DocumentChunk` vector search)
  - Diagram process/relationship semantics (graph fetch + diagram summary vector search)

---

## 2. Document Ingestion and Indexing Flow (RAG)

```mermaid
flowchart TD
    A[Ingest Request\nexternalFileId + userId] --> B[Access Validation\nUser -> Org -> Project -> ExternalFile]
    B --> C{Already Indexed\nand not forceReprocess?}

    C -- Yes --> D[Return existing chunk count]
    C -- No --> E[PDFProcessor\nextract + chunk text]

    E --> F[EmbeddingService\ngenerate chunk embeddings]
    F --> G[VectorStore\nstore DocumentChunk nodes]
    G --> H[Neo4j Vector Index\nper org/project scope]
    H --> I[Ingestion completed\nchunksCreated + timing]
```

What this flow explains:
- Ingestion is secure and scoped by organization/project relationships.
- The system avoids unnecessary recomputation unless forced.
- Final searchable units are text chunks with embeddings in Neo4j.

---

## 3. Diagram Indexing Flow (Graph-RAG Preparation)

```mermaid
flowchart TD
    A[Index Diagram Request\nfileId + projectId + orgId + userId] --> B[DiagramService fetchDiagramData\nnodes edges groups]
    B --> C{Diagram has content?}

    C -- No --> D[Skip indexing]
    C -- Yes --> E[Fingerprint Builder\ncontent hash ignoring layout-only moves]

    E --> F{Fingerprint changed?}
    F -- No --> G[Skip as unchanged]
    F -- Yes --> H[Summarize diagram\nvia LLM summarizer]

    H --> I[Generate embedding\nof summary text]
    I --> J[Upsert DiagramSummaryNode]
    J --> K[Ensure org-specific\nvector index exists]
    K --> L[Diagram summary searchable\nfor semantic routing]
```

What this flow explains:
- Graph-RAG does not just store raw graph data; it creates a semantic summary layer for fast retrieval.
- Fingerprinting prevents expensive re-indexing for non-meaningful visual changes.

---

## 4. Query-Time Agentic Orchestration Flow

```mermaid
flowchart TD
    Q[User message + org/project context] --> S[Load/Create conversation state]
    S --> P[Build system prompt\nwith scope + available diagrams]
    P --> LLM1[LLM follow-up turn]

    LLM1 --> DEC{Tool call requested?}

    DEC -- search_documents --> T1[VectorStore.searchSimilarChunks]
    DEC -- get_diagram_context --> T2[DiagramService fetch + serialize]
    DEC -- none --> ANS1[Direct response candidate]

    T1 --> LOOP[Append tool output to messages]
    T2 --> LOOP
    LOOP --> LLM2[LLM follow-up turn]
    LLM2 --> QC[Quality and sanitation gate\nremove internal retrieval narration]

    ANS1 --> QC
    QC --> SRC["Attach grounded sources\n(document/diagram names + snippets)"]
    SRC --> OUT[Return answer + metadata + conversationId]
```

Agentic features present in your implementation:
- Dynamic tool selection (`search_documents`, `get_diagram_context`).
- Multi-turn tool loop before final answer generation.
- Output sanitation to remove internal retrieval chatter.
- Source-aware final response packaging.

---

## 5. Broad Overview / Multi-Diagram Synthesis Flow
It is for handling overview-style queries (e.g., “Give me a high-level summary of the project”). It forces the agent to pull multiple diagrams before answering, then synthesize across them instead of relying on a single artifact.
```mermaid
flowchart TD
    A[Overview style query\nSummarize project high level overview] --> B[Overview intent detector]
    B --> C["Select multiple relevant diagrams\n(minimum 2 when available)"]

    C --> D1[get_diagram_context: Diagram 1]
    C --> D2[get_diagram_context: Diagram 2]
    C --> DN[get_diagram_context: ...more relevant diagrams]

    D1 --> E[Synthesis workspace]
    D2 --> E[Synthesis workspace]
    DN --> E[Synthesis workspace]

    E --> F[Entity/workstream synthesis\nprocesses, dependencies, actors]
    F --> G[Concise structured answer\nsummary -> key streams -> dependencies -> next drill-downs]
```

Why this is important:
- Prevents shallow single-artifact summaries.
- Encourages cross-diagram evidence aggregation for better project-level explanations.

---

## 6. Major Combined End-to-End Architecture (Master Diagram)

```mermaid
flowchart LR
    subgraph Client
      U[User]
      FE[React Flow UI\naskAi GraphQL client]
      U --> FE
    end

    subgraph Security_and_API
      AUTH[Firebase JWT validation]
      GQL[GraphQL Resolver\nragChat]
      REST[RAG REST routes\ningest/status]
      FE --> AUTH --> GQL
      FE --> AUTH --> REST
    end

    subgraph Orchestration
      ORCH[RAGService\nconversation memory + tool orchestration]
      PROMPT[System Prompt Builder\nscope + diagram list]
      TOOLS[Tool Registry\nsearch_documents / get_diagram_context]
      GQL --> ORCH
      ORCH --> PROMPT
      ORCH --> TOOLS
    end

    subgraph Document_RAG
      INGEST[PDFProcessor\nextract/chunk]
      EMB1[Embedding Service\nchunk + query embeddings]
      VSTORE[VectorStore]
      DCHUNKS[(Neo4j DocumentChunk nodes)]
      DINDEX[(Neo4j Document Vector Index)]

      REST --> INGEST --> EMB1 --> VSTORE --> DCHUNKS --> DINDEX
      ORCH -->|search_documents| VSTORE
    end

    subgraph Graph_RAG
      DSRV[DiagramService\nfetch nodes/edges/groups + serialize]
      DIDX[DiagramIndexService\nfingerprint + summary index]
      SUMM[Diagram Summary Generator]
      EMB2[Embedding Service\nsummary embeddings]
      DGRAPH[(Neo4j File/FlowNode/GroupNode/LINKED_TO)]
      DSUM[(DiagramSummaryNode)]
      DSUMIDX[(Org-specific Diagram Summary Vector Index)]

      ORCH -->|get_diagram_context| DSRV --> DGRAPH
      DGRAPH --> DIDX --> SUMM --> EMB2 --> DSUM --> DSUMIDX
      ORCH --> DIDX
    end

    subgraph LLM_and_Response
      CHATLLM[Chat Completion Model\nwith tool calls]
      QGATE[Grounding + quality gate\nsource check + sanitization]
      RESP[Answer + Sources + Metadata\nconversationId]

      ORCH --> CHATLLM
      VSTORE --> CHATLLM
      DSRV --> CHATLLM
      CHATLLM --> QGATE --> RESP --> GQL --> FE --> U
    end
```

Reading this master diagram:
- Left to right shows the real runtime path from user to final answer.
- Top-level split:
  - API/security entry
  - Orchestrator/agent loop
  - Document RAG subsystem
  - Graph-RAG subsystem
  - Final LLM synthesis and response governance
- Graph-RAG includes both:
  - Live structural retrieval (`DiagramService`)
  - Semantic retrieval accelerator (`DiagramIndexService` + summary embeddings)

---
