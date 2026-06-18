"""
Chunking Strategy Benchmark: SemanticChunker vs RecursiveCharacterTextSplitter

A standalone developer tool for comparing chunking strategies on sample documents.
Measures chunk distribution, Bedrock API costs, processing time, and optionally
retrieval quality via cosine similarity.

Usage:
    python benchmarks/chunking_benchmark.py --file sample.pdf --chunk-sizes 500,1000,1500 --overlap 100
    python benchmarks/chunking_benchmark.py --file sample.pdf --retrieval-test --queries "What is RAG?" "How does embedding work?"

Requirements validated: 5.1, 5.2, 5.3
"""

import argparse
import json
import os
import sys
import time
import tempfile
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np

try:
    from aws_lambda_powertools import Logger
    logger = Logger(service="chunking-benchmark")
except ImportError:
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    logger = logging.getLogger("chunking-benchmark")
    # Add a no-op inject_lambda_context for compatibility
    logger.inject_lambda_context = lambda *a, **kw: (lambda f: f)

import boto3
import fitz  # PyMuPDF

from langchain_core.documents import Document
from langchain_aws import BedrockEmbeddings
from langchain_experimental.text_splitter import SemanticChunker
from langchain_text_splitters import RecursiveCharacterTextSplitter


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class ChunkStats:
    """Statistics for a single chunking strategy run."""
    strategy_name: str
    chunk_count: int
    min_size: int
    max_size: int
    mean_size: float
    median_size: float
    std_size: float
    bedrock_api_calls: int
    estimated_cost_usd: float
    processing_time_seconds: float
    chunk_sizes: List[int] = field(default_factory=list)


@dataclass
class RetrievalResult:
    """Retrieval quality comparison for a single query."""
    query: str
    semantic_top_k_similarities: List[float]
    recursive_top_k_similarities: List[float]
    semantic_mean_similarity: float
    recursive_mean_similarity: float


@dataclass
class BenchmarkReport:
    """Complete benchmark report."""
    file_path: str
    file_size_bytes: int
    page_count: int
    total_text_length: int
    strategies: List[ChunkStats]
    retrieval_results: Optional[List[RetrievalResult]] = None


# ---------------------------------------------------------------------------
# Text extraction
# ---------------------------------------------------------------------------

def extract_text_from_pdf(file_path: str) -> Tuple[str, int]:
    """
    Extract text from a PDF file using PyMuPDF.

    Returns:
        (full_text, page_count)
    """
    doc = fitz.open(file_path)
    pages = []
    for page in doc:
        text = page.get_text().strip()
        if text:
            pages.append(text)
    doc.close()

    full_text = "\n\n".join(pages)
    return full_text, len(pages) if pages else 0


def extract_text_from_txt(file_path: str) -> Tuple[str, int]:
    """Extract text from a plain text file."""
    with open(file_path, "r", encoding="utf-8") as f:
        text = f.read()
    return text, 1


def extract_text(file_path: str) -> Tuple[str, int]:
    """Extract text from a supported file, returns (text, page_count)."""
    ext = Path(file_path).suffix.lower()
    if ext == ".pdf":
        return extract_text_from_pdf(file_path)
    elif ext == ".txt":
        return extract_text_from_txt(file_path)
    else:
        raise ValueError(f"Unsupported file type: {ext}. Supported: .pdf, .txt")


# ---------------------------------------------------------------------------
# Embedding call counter
# ---------------------------------------------------------------------------

class CountingEmbeddings:
    """
    Wrapper around BedrockEmbeddings that counts API calls.
    Used to measure how many Bedrock calls each strategy makes.
    """

    def __init__(self, embeddings: BedrockEmbeddings):
        self._embeddings = embeddings
        self.call_count = 0

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        self.call_count += 1
        return self._embeddings.embed_documents(texts)

    def embed_query(self, text: str) -> List[float]:
        self.call_count += 1
        return self._embeddings.embed_query(text)

    def reset_count(self):
        self.call_count = 0


# ---------------------------------------------------------------------------
# Chunking strategies
# ---------------------------------------------------------------------------

COST_PER_EMBEDDING_CALL = 0.0001  # Assumption from task spec


def benchmark_semantic_chunker(
    text: str,
    embeddings: BedrockEmbeddings,
) -> ChunkStats:
    """
    Benchmark SemanticChunker (current production strategy).
    SemanticChunker uses Bedrock embeddings to decide chunk boundaries.
    """
    counting = CountingEmbeddings(embeddings)

    # SemanticChunker expects an embeddings object with embed_documents
    splitter = SemanticChunker(counting)

    start = time.time()
    chunks = splitter.create_documents([text])
    elapsed = time.time() - start

    chunk_sizes = [len(c.page_content) for c in chunks]

    return ChunkStats(
        strategy_name="SemanticChunker",
        chunk_count=len(chunks),
        min_size=min(chunk_sizes) if chunk_sizes else 0,
        max_size=max(chunk_sizes) if chunk_sizes else 0,
        mean_size=float(np.mean(chunk_sizes)) if chunk_sizes else 0.0,
        median_size=float(np.median(chunk_sizes)) if chunk_sizes else 0.0,
        std_size=float(np.std(chunk_sizes)) if chunk_sizes else 0.0,
        bedrock_api_calls=counting.call_count,
        estimated_cost_usd=counting.call_count * COST_PER_EMBEDDING_CALL,
        processing_time_seconds=elapsed,
        chunk_sizes=chunk_sizes,
    )


def benchmark_recursive_splitter(
    text: str,
    chunk_size: int,
    chunk_overlap: int,
) -> ChunkStats:
    """
    Benchmark RecursiveCharacterTextSplitter (candidate replacement).
    This strategy makes zero Bedrock API calls for chunking decisions.
    """
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        length_function=len,
        separators=["\n\n", "\n", ". ", " ", ""],
    )

    start = time.time()
    chunks = splitter.create_documents([text])
    elapsed = time.time() - start

    chunk_sizes = [len(c.page_content) for c in chunks]

    return ChunkStats(
        strategy_name=f"RecursiveCharacterTextSplitter(size={chunk_size}, overlap={chunk_overlap})",
        chunk_count=len(chunks),
        min_size=min(chunk_sizes) if chunk_sizes else 0,
        max_size=max(chunk_sizes) if chunk_sizes else 0,
        mean_size=float(np.mean(chunk_sizes)) if chunk_sizes else 0.0,
        median_size=float(np.median(chunk_sizes)) if chunk_sizes else 0.0,
        std_size=float(np.std(chunk_sizes)) if chunk_sizes else 0.0,
        bedrock_api_calls=0,  # RecursiveCharacterTextSplitter makes zero embedding calls
        estimated_cost_usd=0.0,
        processing_time_seconds=elapsed,
        chunk_sizes=chunk_sizes,
    )


# ---------------------------------------------------------------------------
# Retrieval quality test
# ---------------------------------------------------------------------------

def cosine_similarity(a: List[float], b: List[float]) -> float:
    """Compute cosine similarity between two vectors."""
    a_arr = np.array(a)
    b_arr = np.array(b)
    dot = np.dot(a_arr, b_arr)
    norm_a = np.linalg.norm(a_arr)
    norm_b = np.linalg.norm(b_arr)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))


def run_retrieval_test(
    text: str,
    queries: List[str],
    embeddings: BedrockEmbeddings,
    chunk_size: int = 1000,
    chunk_overlap: int = 100,
    top_k: int = 5,
) -> List[RetrievalResult]:
    """
    Compare retrieval quality between SemanticChunker and RecursiveCharacterTextSplitter.

    For each query:
      1. Embeds the query
      2. Embeds all chunks from both strategies
      3. Computes cosine similarity
      4. Returns top-k similarities for comparison
    """
    results = []

    # Chunk with both strategies
    semantic_splitter = SemanticChunker(embeddings)
    recursive_splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        length_function=len,
        separators=["\n\n", "\n", ". ", " ", ""],
    )

    logger.info("Creating semantic chunks for retrieval test...")
    semantic_chunks = semantic_splitter.create_documents([text])
    semantic_texts = [c.page_content for c in semantic_chunks]

    logger.info("Creating recursive chunks for retrieval test...")
    recursive_chunks = recursive_splitter.create_documents([text])
    recursive_texts = [c.page_content for c in recursive_chunks]

    # Embed all chunks
    logger.info(
        "Embedding chunks for retrieval test...",
        extra={
            "semantic_chunk_count": len(semantic_texts),
            "recursive_chunk_count": len(recursive_texts),
        } if hasattr(logger, "info") and not isinstance(logger, logging.Logger) else {},
    )
    semantic_embeddings = embeddings.embed_documents(semantic_texts)
    recursive_embeddings = embeddings.embed_documents(recursive_texts)

    for query in queries:
        logger.info(f"Testing query: {query[:80]}...")
        query_embedding = embeddings.embed_query(query)

        # Compute similarities
        semantic_sims = [
            cosine_similarity(query_embedding, emb) for emb in semantic_embeddings
        ]
        recursive_sims = [
            cosine_similarity(query_embedding, emb) for emb in recursive_embeddings
        ]

        # Get top-k
        semantic_top_k = sorted(semantic_sims, reverse=True)[:top_k]
        recursive_top_k = sorted(recursive_sims, reverse=True)[:top_k]

        results.append(RetrievalResult(
            query=query,
            semantic_top_k_similarities=semantic_top_k,
            recursive_top_k_similarities=recursive_top_k,
            semantic_mean_similarity=float(np.mean(semantic_top_k)) if semantic_top_k else 0.0,
            recursive_mean_similarity=float(np.mean(recursive_top_k)) if recursive_top_k else 0.0,
        ))

    return results


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------

def format_report_table(report: BenchmarkReport) -> str:
    """Format the benchmark report as a readable table."""
    lines = []
    lines.append("=" * 80)
    lines.append("CHUNKING STRATEGY BENCHMARK REPORT")
    lines.append("=" * 80)
    lines.append(f"File: {report.file_path}")
    lines.append(f"Size: {report.file_size_bytes:,} bytes")
    lines.append(f"Pages: {report.page_count}")
    lines.append(f"Text length: {report.total_text_length:,} characters")
    lines.append("")
    lines.append("-" * 80)
    lines.append(f"{'Strategy':<55} {'Chunks':>6} {'Mean':>7} {'Median':>7} {'Std':>7}")
    lines.append("-" * 80)

    for s in report.strategies:
        lines.append(
            f"{s.strategy_name:<55} {s.chunk_count:>6} "
            f"{s.mean_size:>7.0f} {s.median_size:>7.0f} {s.std_size:>7.0f}"
        )

    lines.append("")
    lines.append("-" * 80)
    lines.append(f"{'Strategy':<55} {'API Calls':>10} {'Cost ($)':>10} {'Time (s)':>10}")
    lines.append("-" * 80)

    for s in report.strategies:
        lines.append(
            f"{s.strategy_name:<55} {s.bedrock_api_calls:>10} "
            f"{s.estimated_cost_usd:>10.4f} {s.processing_time_seconds:>10.2f}"
        )

    if report.retrieval_results:
        lines.append("")
        lines.append("=" * 80)
        lines.append("RETRIEVAL QUALITY COMPARISON")
        lines.append("=" * 80)
        lines.append(f"{'Query':<50} {'Semantic':>12} {'Recursive':>12} {'Delta':>8}")
        lines.append("-" * 80)

        for r in report.retrieval_results:
            delta = r.semantic_mean_similarity - r.recursive_mean_similarity
            query_display = r.query[:47] + "..." if len(r.query) > 50 else r.query
            lines.append(
                f"{query_display:<50} {r.semantic_mean_similarity:>12.4f} "
                f"{r.recursive_mean_similarity:>12.4f} {delta:>+8.4f}"
            )

    lines.append("")
    lines.append("=" * 80)
    return "\n".join(lines)


def format_report_json(report: BenchmarkReport) -> str:
    """Format the benchmark report as JSON."""
    data = {
        "file_path": report.file_path,
        "file_size_bytes": report.file_size_bytes,
        "page_count": report.page_count,
        "total_text_length": report.total_text_length,
        "strategies": [],
        "retrieval_results": None,
    }

    for s in report.strategies:
        strategy_data = asdict(s)
        # Remove the raw chunk_sizes list from JSON output to keep it compact
        strategy_data.pop("chunk_sizes", None)
        data["strategies"].append(strategy_data)

    if report.retrieval_results:
        data["retrieval_results"] = [asdict(r) for r in report.retrieval_results]

    return json.dumps(data, indent=2)


# ---------------------------------------------------------------------------
# Main benchmark runner
# ---------------------------------------------------------------------------

def run_benchmark(
    file_path: str,
    chunk_sizes: List[int],
    chunk_overlap: int,
    run_retrieval: bool = False,
    queries: Optional[List[str]] = None,
    output_format: str = "table",
    region: str = "ca-central-1",
    model_id: Optional[str] = None,
    top_k: int = 5,
) -> BenchmarkReport:
    """
    Run the full chunking benchmark.

    Args:
        file_path: Path to the document to benchmark.
        chunk_sizes: List of chunk sizes for RecursiveCharacterTextSplitter.
        chunk_overlap: Overlap for RecursiveCharacterTextSplitter.
        run_retrieval: Whether to run the retrieval quality test.
        queries: Sample queries for retrieval test.
        output_format: "table" or "json".
        region: AWS region for Bedrock.
        model_id: Bedrock embedding model ID (defaults to Amazon Titan).
        top_k: Number of top results to compare in retrieval test.

    Returns:
        BenchmarkReport with all results.
    """
    if model_id is None:
        model_id = "amazon.titan-embed-text-v1"

    # Initialize Bedrock embeddings (same model as production)
    bedrock_client = boto3.client("bedrock-runtime", region_name=region)
    embeddings = BedrockEmbeddings(
        client=bedrock_client,
        model_id=model_id,
    )

    # Extract text
    logger.info(f"Extracting text from: {file_path}")
    text, page_count = extract_text(file_path)
    file_size = os.path.getsize(file_path)

    if not text.strip():
        raise ValueError(f"No text extracted from {file_path}")

    logger.info(
        "Text extracted",
        extra={"page_count": page_count, "text_length": len(text)}
        if not isinstance(logger, logging.Logger) else {},
    )

    strategies: List[ChunkStats] = []

    # Benchmark SemanticChunker
    logger.info("Benchmarking SemanticChunker...")
    semantic_stats = benchmark_semantic_chunker(text, embeddings)
    strategies.append(semantic_stats)
    logger.info(
        f"SemanticChunker: {semantic_stats.chunk_count} chunks, "
        f"{semantic_stats.bedrock_api_calls} API calls, "
        f"{semantic_stats.processing_time_seconds:.2f}s"
    )

    # Benchmark RecursiveCharacterTextSplitter for each chunk size
    for size in chunk_sizes:
        logger.info(f"Benchmarking RecursiveCharacterTextSplitter(size={size}, overlap={chunk_overlap})...")
        recursive_stats = benchmark_recursive_splitter(text, size, chunk_overlap)
        strategies.append(recursive_stats)
        logger.info(
            f"RecursiveCharacterTextSplitter(size={size}): {recursive_stats.chunk_count} chunks, "
            f"0 API calls, {recursive_stats.processing_time_seconds:.2f}s"
        )

    # Retrieval quality test
    retrieval_results = None
    if run_retrieval and queries:
        logger.info("Running retrieval quality test...")
        # Use the middle chunk size for the retrieval comparison
        comparison_size = chunk_sizes[len(chunk_sizes) // 2] if chunk_sizes else 1000
        retrieval_results = run_retrieval_test(
            text=text,
            queries=queries,
            embeddings=embeddings,
            chunk_size=comparison_size,
            chunk_overlap=chunk_overlap,
            top_k=top_k,
        )

    report = BenchmarkReport(
        file_path=file_path,
        file_size_bytes=file_size,
        page_count=page_count,
        total_text_length=len(text),
        strategies=strategies,
        retrieval_results=retrieval_results,
    )

    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Benchmark chunking strategies: SemanticChunker vs RecursiveCharacterTextSplitter",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python benchmarks/chunking_benchmark.py --file sample.pdf
  python benchmarks/chunking_benchmark.py --file sample.pdf --chunk-sizes 500,1000,1500 --overlap 100
  python benchmarks/chunking_benchmark.py --file sample.pdf --retrieval-test --queries "What is RAG?"
  python benchmarks/chunking_benchmark.py --file sample.pdf --output json > results.json
        """,
    )

    parser.add_argument(
        "--file",
        required=True,
        help="Path to the sample document (PDF or TXT)",
    )
    parser.add_argument(
        "--chunk-sizes",
        type=str,
        default="500,1000,1500",
        help="Comma-separated list of chunk sizes for RecursiveCharacterTextSplitter (default: 500,1000,1500)",
    )
    parser.add_argument(
        "--overlap",
        type=int,
        default=100,
        help="Chunk overlap for RecursiveCharacterTextSplitter (default: 100)",
    )
    parser.add_argument(
        "--retrieval-test",
        action="store_true",
        help="Run retrieval quality comparison using cosine similarity",
    )
    parser.add_argument(
        "--queries",
        nargs="+",
        default=None,
        help="Sample queries for retrieval test (required with --retrieval-test)",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=5,
        help="Number of top results to compare in retrieval test (default: 5)",
    )
    parser.add_argument(
        "--output",
        choices=["table", "json"],
        default="table",
        help="Output format (default: table)",
    )
    parser.add_argument(
        "--region",
        type=str,
        default="ca-central-1",
        help="AWS region for Bedrock (default: ca-central-1)",
    )
    parser.add_argument(
        "--model-id",
        type=str,
        default=None,
        help="Bedrock embedding model ID (default: amazon.titan-embed-text-v1)",
    )

    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> None:
    """Main entry point for the benchmark script."""
    args = parse_args(argv)

    # Validate file exists
    if not os.path.isfile(args.file):
        print(f"Error: File not found: {args.file}", file=sys.stderr)
        sys.exit(1)

    # Parse chunk sizes
    try:
        chunk_sizes = [int(s.strip()) for s in args.chunk_sizes.split(",")]
    except ValueError:
        print(f"Error: Invalid chunk sizes: {args.chunk_sizes}", file=sys.stderr)
        sys.exit(1)

    # Validate retrieval test args
    if args.retrieval_test and not args.queries:
        print(
            "Error: --queries is required when using --retrieval-test",
            file=sys.stderr,
        )
        sys.exit(1)

    # Run benchmark
    report = run_benchmark(
        file_path=args.file,
        chunk_sizes=chunk_sizes,
        chunk_overlap=args.overlap,
        run_retrieval=args.retrieval_test,
        queries=args.queries,
        output_format=args.output,
        region=args.region,
        model_id=args.model_id,
        top_k=args.top_k,
    )

    # Output results
    if args.output == "json":
        print(format_report_json(report))
    else:
        print(format_report_table(report))


if __name__ == "__main__":
    main()
