# Setup script for Ollama local models (Windows PowerShell)
# Run this after installing Ollama

Write-Host "🚀 Setting up Ollama local models..." -ForegroundColor Cyan
Write-Host ""

# Check if Ollama is installed
$ollamaExists = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaExists) {
    Write-Host "❌ Ollama is not installed!" -ForegroundColor Red
    Write-Host "📥 Download from: https://ollama.ai/download" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

Write-Host "✅ Ollama is installed" -ForegroundColor Green
Write-Host ""

# Pull embedding model
Write-Host "📦 Pulling qwen3-embedding:0.6b (1024 dimensions)..." -ForegroundColor Yellow
ollama pull qwen3-embedding:0.6b

# Pull chat model
Write-Host ""
Write-Host "📦 Pulling qwen2.5:7b (chat model)..." -ForegroundColor Yellow
ollama pull qwen2.5:7b

Write-Host ""
Write-Host "✅ Models downloaded successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "📝 Next steps:" -ForegroundColor Cyan
Write-Host "   1. Add to your .env file:"
Write-Host "      USE_LOCAL_MODELS=true"
Write-Host "      USE_OLLAMA=true"
Write-Host "      OLLAMA_BASE_URL=http://localhost:11434"
Write-Host "      OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b"
Write-Host "      OLLAMA_CHAT_MODEL=qwen2.5:7b"
Write-Host ""
Write-Host "   2. Clear old Neo4j vector indices (they have wrong dimensions):"
Write-Host "      Run in Neo4j Browser:"
Write-Host "      SHOW INDEXES WHERE type = 'VECTOR' YIELD name" -ForegroundColor Gray
Write-Host "      // Then drop each one: DROP INDEX index_name" -ForegroundColor Gray
Write-Host ""
Write-Host "   3. Restart your backend: npm run dev"
Write-Host ""
Write-Host "🎉 Setup complete! Your app will now use local models." -ForegroundColor Green
