"""Unit tests for evaluate_answer in evaluation.py"""
import sys
sys.path.insert(0, '.')
import json
import io
from unittest.mock import MagicMock
from evaluation import evaluate_answer, EvaluationResult, DEFAULT_EVALUATION


def make_bedrock_response(response_json: dict) -> MagicMock:
    """Create a mock Bedrock response with the given JSON body."""
    body_content = json.dumps({
        "content": [{"text": json.dumps(response_json)}]
    }).encode()
    mock_response = {
        "body": io.BytesIO(body_content)
    }
    return mock_response


# Test 1: Successful evaluation call returns correct result
def test_successful_evaluation():
    client = MagicMock()
    response_data = {
        "correct": True,
        "partial": False,
        "confidence": 0.85,
        "concepts_demonstrated": ["recursion", "loops"],
        "concepts_misunderstood": []
    }
    client.invoke_model.return_value = make_bedrock_response(response_data)

    result = evaluate_answer(
        bedrock_client=client,
        topic="Data Structures",
        stage="comprehension",
        last_ai_question="Explain how recursion works.",
        student_answer="Recursion is when a function calls itself with a smaller problem.",
        concepts="recursion, base case, stack frames",
        module_concepts=["recursion", "loops", "variables"],
    )

    assert result.correct is True
    assert result.partial is False
    assert result.confidence == 0.85
    assert result.concepts_demonstrated == ["recursion", "loops"]
    assert result.concepts_misunderstood == []
    # Verify invoke_model was called with correct model ID
    call_args = client.invoke_model.call_args
    assert call_args.kwargs["modelId"] == "anthropic.claude-3-haiku-20240307-v1:0"
    assert call_args.kwargs["contentType"] == "application/json"
    assert call_args.kwargs["accept"] == "application/json"
    print("Test 1 passed: Successful evaluation call returns correct result")


# Test 2: Non-canonical concepts are filtered
def test_filters_non_canonical_concepts():
    client = MagicMock()
    response_data = {
        "correct": True,
        "partial": False,
        "confidence": 0.9,
        "concepts_demonstrated": ["recursion", "unknown_concept"],
        "concepts_misunderstood": ["nonexistent"]
    }
    client.invoke_model.return_value = make_bedrock_response(response_data)

    result = evaluate_answer(
        bedrock_client=client,
        topic="Algorithms",
        stage="application",
        last_ai_question="Implement a recursive factorial.",
        student_answer="def factorial(n): return 1 if n <= 1 else n * factorial(n-1)",
        concepts="recursion, factorial",
        module_concepts=["recursion", "loops"],
    )

    assert result.concepts_demonstrated == ["recursion"]
    assert result.concepts_misunderstood == []
    print("Test 2 passed: Non-canonical concepts are filtered")


# Test 3: Bedrock client exception returns DEFAULT_EVALUATION
def test_bedrock_exception_returns_default():
    client = MagicMock()
    client.invoke_model.side_effect = Exception("Bedrock throttling")

    result = evaluate_answer(
        bedrock_client=client,
        topic="Python",
        stage="prior_knowledge",
        last_ai_question="What is a variable?",
        student_answer="A container for data",
        concepts="variables, assignment",
        module_concepts=["variables", "types"],
    )

    assert result.correct == DEFAULT_EVALUATION.correct
    assert result.partial == DEFAULT_EVALUATION.partial
    assert result.confidence == DEFAULT_EVALUATION.confidence
    assert result.concepts_demonstrated == DEFAULT_EVALUATION.concepts_demonstrated
    assert result.concepts_misunderstood == DEFAULT_EVALUATION.concepts_misunderstood
    print("Test 3 passed: Bedrock client exception returns DEFAULT_EVALUATION")


# Test 4: Malformed response body returns DEFAULT_EVALUATION
def test_malformed_response_returns_default():
    client = MagicMock()
    body_content = b"not valid json"
    client.invoke_model.return_value = {"body": io.BytesIO(body_content)}

    result = evaluate_answer(
        bedrock_client=client,
        topic="Math",
        stage="comprehension",
        last_ai_question="Explain derivatives.",
        student_answer="Rate of change",
        concepts="derivatives, limits",
        module_concepts=["derivatives", "limits"],
    )

    assert result.correct == DEFAULT_EVALUATION.correct
    assert result.partial == DEFAULT_EVALUATION.partial
    print("Test 4 passed: Malformed response body returns DEFAULT_EVALUATION")


# Test 5: Request body contains correct prompt structure
def test_request_body_structure():
    client = MagicMock()
    response_data = {
        "correct": False,
        "partial": True,
        "confidence": 0.6,
        "concepts_demonstrated": [],
        "concepts_misunderstood": ["sorting"]
    }
    client.invoke_model.return_value = make_bedrock_response(response_data)

    module_concepts = ["sorting", "searching", "hashing"]
    evaluate_answer(
        bedrock_client=client,
        topic="Algorithms",
        stage="prior_knowledge",
        last_ai_question="How does bubble sort work?",
        student_answer="It compares elements",
        concepts="sorting, comparison",
        module_concepts=module_concepts,
    )

    call_args = client.invoke_model.call_args
    body = json.loads(call_args.kwargs["body"])
    assert body["anthropic_version"] == "bedrock-2023-05-31"
    assert body["max_tokens"] == 500
    assert len(body["messages"]) == 1
    assert body["messages"][0]["role"] == "user"
    # Verify prompt contains key elements
    prompt_content = body["messages"][0]["content"]
    assert "Algorithms" in prompt_content
    assert "prior_knowledge" in prompt_content
    assert "How does bubble sort work?" in prompt_content
    assert "It compares elements" in prompt_content
    assert "sorting, comparison" in prompt_content
    assert json.dumps(module_concepts) in prompt_content
    print("Test 5 passed: Request body contains correct prompt structure")


# Test 6: Module concepts passed as JSON in prompt
def test_module_concepts_in_prompt():
    client = MagicMock()
    response_data = {
        "correct": True,
        "partial": False,
        "confidence": 0.95,
        "concepts_demonstrated": ["trees"],
        "concepts_misunderstood": []
    }
    client.invoke_model.return_value = make_bedrock_response(response_data)

    module_concepts = ["trees", "graphs", "heaps"]
    evaluate_answer(
        bedrock_client=client,
        topic="Data Structures",
        stage="mastery",
        last_ai_question="Compare BSTs and AVL trees.",
        student_answer="AVL trees are self-balancing BSTs.",
        concepts="BST, AVL, balance factor",
        module_concepts=module_concepts,
    )

    call_args = client.invoke_model.call_args
    body = json.loads(call_args.kwargs["body"])
    prompt = body["messages"][0]["content"]
    # module_concepts should be serialized as JSON in the prompt
    assert '["trees", "graphs", "heaps"]' in prompt
    print("Test 6 passed: Module concepts passed as JSON in prompt")


if __name__ == "__main__":
    test_successful_evaluation()
    test_filters_non_canonical_concepts()
    test_bedrock_exception_returns_default()
    test_malformed_response_returns_default()
    test_request_body_structure()
    test_module_concepts_in_prompt()
    print("\nAll evaluate_answer tests passed!")
