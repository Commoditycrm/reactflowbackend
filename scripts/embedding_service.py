"""
Local Embedding Service using HuggingFace models
Supports multilingual-e5-large-instruct and other embedding models

Requirements:
    pip install torch transformers sentence-transformers flask

Usage:
    python embedding_service.py

Then set in .env:
    EMBEDDING_SERVICE_URL=http://localhost:5001/embed
"""

from flask import Flask, request, jsonify
from sentence_transformers import SentenceTransformer
import torch
import os

app = Flask(__name__)

# Configuration
MODEL_NAME = os.getenv("EMBEDDING_MODEL", "intfloat/multilingual-e5-large-instruct")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
PORT = int(os.getenv("EMBEDDING_SERVICE_PORT", "5001"))

print(f"Loading model: {MODEL_NAME}")
print(f"Using device: {DEVICE}")

# Load model
model = SentenceTransformer(MODEL_NAME, device=DEVICE)

# For e5 models, we need to add instruction prefix
def get_detailed_instruct(task_description: str, query: str) -> str:
    return f'Instruct: {task_description}\nQuery: {query}'

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "model": MODEL_NAME, "device": DEVICE})

@app.route('/embed', methods=['POST'])
def embed():
    try:
        data = request.get_json()
        text = data.get('text', '')
        use_instruction = data.get('use_instruction', True)
        
        if not text:
            return jsonify({"error": "No text provided"}), 400
        
        # For e5 models, add instruction
        if use_instruction and 'e5' in MODEL_NAME.lower():
            task = 'Given a document, retrieve relevant information'
            text = get_detailed_instruct(task, text)
        
        # Generate embedding
        embedding = model.encode(text, convert_to_numpy=True)
        
        return jsonify({
            "embedding": embedding.tolist(),
            "model": MODEL_NAME,
            "dimensions": len(embedding)
        })
    
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/embed_batch', methods=['POST'])
def embed_batch():
    try:
        data = request.get_json()
        texts = data.get('texts', [])
        use_instruction = data.get('use_instruction', True)
        
        if not texts:
            return jsonify({"error": "No texts provided"}), 400
        
        # For e5 models, add instruction
        if use_instruction and 'e5' in MODEL_NAME.lower():
            task = 'Given a document, retrieve relevant information'
            texts = [get_detailed_instruct(task, text) for text in texts]
        
        # Generate embeddings
        embeddings = model.encode(texts, convert_to_numpy=True, batch_size=8)
        
        return jsonify({
            "embeddings": [emb.tolist() for emb in embeddings],
            "model": MODEL_NAME,
            "dimensions": len(embeddings[0]) if len(embeddings) > 0 else 0,
            "count": len(embeddings)
        })
    
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    print(f"Starting embedding service on port {PORT}")
    print(f"Embedding dimension: {model.get_sentence_embedding_dimension()}")
    app.run(host='0.0.0.0', port=PORT, debug=False)
