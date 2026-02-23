# Local Models Setup Guide

This guide helps you set up local open-source models instead of using OpenAI API.

## Option 1: Ollama (Recommended - Easiest)

### Installation

1. **Download Ollama**: https://ollama.ai/download
2. **Install and start Ollama**
3. **Pull models**:
   ```bash
   # For embeddings (1024 dims, ~600MB)
   ollama pull qwen3-embedding:0.6b
   
   # For chat - choose one:
   ollama pull qwen2.5:7b      # 4.7GB, excellent quality
   ollama pull mistral:7b      # 4.1GB, good balance
   ollama pull phi3:3.8b       # 2.2GB, smaller but decent
   ```

### Configuration

Add to your `.env` file:
```env
# Use Ollama for embeddings and chat
USE_OLLAMA=true
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b
OLLAMA_CHAT_MODEL=qwen2.5:7b

# Note: qwen3-embedding:0.6b produces 1024-dimensional embeddings
# You'll need to update RAG_CONFIG.EMBEDDING_DIMENSIONS to 1024
```

### Update Code

In `src/rag/types/rag.types.ts`, change:
```typescript
export const RAG_CONFIG = {
  // ... other config
  EMBEDDING_DIMENSIONS: 1024,  // Changed for qwen3-embedding:0.6b
  DIAGRAM_SUMMARY_EMBEDDING_DIMENSIONS: 1024,  // Also update this
  // ... rest of config
}
```

**Important**: After changing dimensions, you'll need to:
1. Delete existing Neo4j vector indices
2. Re-index your documents

---

## Option 2: Python Service with multilingual-e5-large-instruct

This option uses the exact model you mentioned: `intfloat/multilingual-e5-large-instruct`

### Installation

1. **Install Python dependencies**:
   ```bash
   pip install -r requirements-embeddings.txt
   ```

2. **Start the embedding service**:
   ```bash
   # Will automatically download multilingual-e5-large-instruct (~1.5GB)
   python scripts/embedding_service.py
   ```

3. **For chat, use Ollama** (from Option 1):
   ```bash
   ollama pull qwen2.5:7b
   ```

### Configuration

Add to your `.env` file:
```env
# Use Python service for embeddings
USE_OLLAMA=false
EMBEDDING_SERVICE_URL=http://localhost:5001/embed

# Use Ollama for chat
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_CHAT_MODEL=qwen2.5:7b

# multilingual-e5-large-instruct produces 1024-dimensional embeddings
```

In `src/rag/types/rag.types.ts`, change:
```typescript
export const RAG_CONFIG = {
  // ... other config
  EMBEDDING_DIMENSIONS: 1024,  // For multilingual-e5-large-instruct
  DIAGRAM_SUMMARY_EMBEDDING_DIMENSIONS: 1024,
  // ... rest of config
}
```

### Using a Different Embedding Model

Edit `scripts/embedding_service.py` and change:
```python
MODEL_NAME = os.getenv("EMBEDDING_MODEL", "your-model-name-here")
```

Or set environment variable:
```bash
EMBEDDING_MODEL=sentence-transformers/all-mpnet-base-v2 python scripts/embedding_service.py
```

Popular models:
- `intfloat/multilingual-e5-large-instruct` - 1024 dims, 1.5GB, multilingual
- `sentence-transformers/all-mpnet-base-v2` - 768 dims, 420MB, English
- `BAAI/bge-large-en-v1.5` - 1024 dims, 1.34GB, excellent quality
- `intfloat/e5-large-v2` - 1024 dims, 1.34GB, high quality

---

## GPU Memory Usage

For your 8GB GPU:

###qwen3-embedding:0.6b`: ~800MB VRAM
- `qwen2.5:7b`: ~5GB VRAM (4-bit quantized)
- **Total**: ~5.85GB VRAM (4-bit quantized)
- **Total**: ~5.3GB VRAM ✅ Fits comfortably

### Python + Ollama
- `multilingual-e5-large-instruct`: ~2GB VRAM (FP16)
- `qwen2.5:7b` (Ollama): ~5GB VRAM
- **Total**: ~7GB VRAM ✅ Should fit

**Tip**: If you run out of memory, use `phi3:3.8b` instead of `qwen2.5:7b` for chat.

---

## Switching Code to Use Local Models

Update `src/rag/services/RAGService.ts` and other services to use `LocalEmbeddingService`:

```typescript
import { LocalEmbeddingService } from './LocalEmbeddingService';

// Replace this:
// const embeddingService = EmbeddingService.getInstance();

// With this:
const embeddingService = LocalEmbeddingService.getInstance();
```

---

## Testing

1. **Test embedding service**:
   ```bash
   curl -X POST http://localhost:5001/embed \
     -H "Content-Type: application/json" \
     -d '{"text": "Hello world"}'
   ```

2. **Test Ollama**:
   ```bash
   curl http://localhost:11434/api/embeddings \
     -d '{
       "model": "nomic-embed-text",
       "prompt": "Hello world"
     }'
   ```

---

## Performance Comparison

| Model | Size | VRAM | Speed (RTX 3060) | Quality |
|-------|------|------|------------------|---------|
| qwen3-embedding:0.6b | 600MB | 800MB | ~4 0MB | ~200ms | ⭐⭐⭐⭐ |
| nomic-embed-text | 274MB | 300MB | ~50ms | ⭐⭐⭐⭐ |
| multilingual-e5-large-instruct | 1.5GB | 2GB | ~80ms | ⭐⭐⭐⭐⭐ |

---

## Troubleshooting

### "CUDA out of memory"
- Use smaller models: `phi3:3.8b` for chat
- Close other GPU-using applications
- Enable CPU offloading in the Python service

### "Ollama not responding"
- Check if Ollama is running: `ollama list`
- Restart Ollama service
- Check firewall settings

### "Python service slow"
- First request is always slower (model loading)
- Enable GPU in PyTorch: check `torch.cuda.is_available()`
- Reduce batch size in the code
