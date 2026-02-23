# Quick Start: Using Local Models

## ⚡ Fastest Setup (Ollama - Recommended)

### 1. Install Ollama
Download from: https://ollama.ai/download

### 2. Pull Models
```bash
# Embedding model (1024 dimensions, ~600MB)
ollama pull qwen3-embedding:0.6b

# Chat model - pick one:
ollama pull qwen2.5:7b      # 4.7GB - Best quality
ollama pull mistral:7b      # 4.1GB - Good balance  
ollama pull phi3:3.8b       # 2.2GB - Fits 8GB GPU easily
```

### 3. Update .env
Add these lines to your `.env` file:
```env
# Enable local models
USE_LOCAL_MODELS=true
USE_OLLAMA=true

# Ollama configuration
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b
OLLAMA_CHAT_MODEL=qwen2.5:7b
```

### 4. Update RAG_CONFIG dimensions
Edit `src/rag/types/rag.types.ts`:
```typescript
export const RAG_CONFIG = {
  // ... other config ...
  EMBEDDING_DIMENSIONS: 1024,  // Changed for qwen3-embedding:0.6b
  DIAGRAM_SUMMARY_EMBEDDING_DIMENSIONS: 1024,
  // ... rest of config ...
}
```

**✅ Already done!** The dimensions are already set to 1024.

### 5. Clear Old Indices (Important!)
Since you changed embedding dimensions, you need to clear old Neo4j indices.

Run in Neo4j browser or your admin tool:
```cypher
// Drop all old vector indices
SHOW INDEXES WHERE type = "VECTOR" YIELD name
CALL apoc.periodic.iterate(
  "SHOW INDEXES WHERE type = 'VECTOR' YIELD name RETURN name",
  "DROP INDEX $name",
  {}
);

// Or manually:
DROP INDEX document_embeddings_org_YOUR_ORG_ID;
DROP INDEX diagram_summary_embeddings_org_YOUR_ORG_ID;
```

### 6. Restart and Test
```bash
npm run dev
```

Then test the endpoint again:
```powershell
$headers = @{
  "Content-Type" = "application/json"
  "Authorization" = "Bearer YOUR_FRESH_TOKEN"
}

$body = @{
  projectId = "c9cb3aa9-944b-4355-b8c1-eab6b5689bf4"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:4000/api/v1/rag/index-project-diagrams" -Method POST -Headers $headers -Body $body
```

---

## 🐍 Alternative: Python + multilingual-e5-large-instruct

If you want to use the exact model you mentioned:

### 1. Install Python Dependencies
```bash
pip install -r requirements-embeddings.txt
```

### 2. Start Embedding Service
```bash
# Downloads multilingual-e5-large-instruct automatically (~1.5GB)
python scripts/embedding_service.py
```

### 3. Update .env
```env
USE_LOCAL_MODELS=true
USE_OLLAMA=false
EMBEDDING_SERVICE_URL=http://localhost:5001/embed

# Still use Ollama for chat
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_CHAT_MODEL=qwen2.5:7b
```

### 4. Update RAG_CONFIG dimensions
```typescript
export const RAG_CONFIG = {
  // ... other config ...
  EMBEDDING_DIMENSIONS: 1024,  // multilingual-e5-large-instruct
  DIAGRAM_SUMMARY_EMBEDDING_DIMENSIONS: 1024,
  // ... rest of config ...
}
```

Then follow steps 5-6 from above.

---

## 🧪 Testing Local Services

### Test Ollama Embeddings
```bash
curl http://loqwen3-embedding:0.6bi/embeddings \
  -d '{
    "model": "nomic-embed-text",
    "prompt": "Hello world"
  }'
```

### Test Python Embedding Service
```bash
curl -X POST http://localhost:5001/embed \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}'
```

### Test Ollama Chat
```bash
curl http://localhost:11434/api/chat \
  -d '{
    "model": "qwen2.5:7b",
    "messages": [{"role": "user", "content": "Say hello!"}],
    "stream": false
  }'
```

---

## 📊 GPU Memory Usage

Your 8GB RTX 3060:
- ✅ qwen3-embedding:0.6b + qwen2.5:7b = ~5.8GB VRAM
- ✅ multilingual-e5-large + qwen2.5:7b = ~7GB VRAM
- ✅ Any model + phi3:3.8b = Comfortable fit

---

## 🔄 Switching Back to OpenAI

Just change in `.env`:
```env
USE_LOCAL_MODELS=false
```

And revert the embedding dimensions in RAG_CONFIG back to `1536`.

---

## ❓ Troubleshooting

**Port already in use (Ollama)**
- Ollama uses port 11434 by default
- Check if it's running: `ollama list`

**Python service not starting**
- Check GPU: `python -c "import torch; print(torch.cuda.is_available())"`
- Try CPU mode if GPU fails (slower but works)

**Neo4j index errors**
- Make sure you dropped old indices with different dimensions
- Restart Neo4j after dropping indices

**Out of memory**
- Use smaller chat model: `phi3:3.8b` instead of `qwen2.5:7b`
- Close other GPU applications

---

## 📖 Full Documentation

See [LOCAL_MODELS_SETUP.md](./LOCAL_MODELS_SETUP.md) for detailed information.
