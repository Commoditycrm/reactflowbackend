#!/bin/bash

# Setup script for Ollama local models
# Run this after installing Ollama

echo "🚀 Setting up Ollama local models..."
echo ""

# Check if Ollama is installed
if ! command -v ollama &> /dev/null; then
    echo "❌ Ollama is not installed!"
    echo "📥 Download from: https://ollama.ai/download"
    echo ""
    exit 1
fi

echo "✅ Ollama is installed"
echo ""

# Pull embedding model
echo "📦 Pulling qwen3-embedding:0.6b (1024 dimensions)..."
ollama pull qwen3-embedding:0.6b

# Pull chat model
echo ""
echo "📦 Pulling qwen2.5:7b (chat model)..."
ollama pull qwen2.5:7b

echo ""
echo "✅ Models downloaded successfully!"
echo ""
echo "📝 Next steps:"
echo "   1. Add to your .env file:"
echo "      USE_LOCAL_MODELS=true"
echo "      USE_OLLAMA=true"
echo "      OLLAMA_BASE_URL=http://localhost:11434"
echo "      OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b"
echo "      OLLAMA_CHAT_MODEL=qwen2.5:7b"
echo ""
echo "   2. Clear old Neo4j vector indices (they have wrong dimensions):"
echo "      See QUICK_START_LOCAL_MODELS.md section 5"
echo ""
echo "   3. Restart your backend: npm run dev"
echo ""
echo "🎉 Setup complete! Your app will now use local models."
