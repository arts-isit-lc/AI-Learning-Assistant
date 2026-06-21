"""Unit tests for parse_evaluation_response in evaluation.py"""
import sys
sys.path.insert(0, '.')
import json
from evaluation import parse_evaluation_response, EvaluationResult, DEFAULT_EVALUATION


# Test 1: Valid JSON parses correctly
module_concepts = ["recursion", "loops", "variables", "functions"]
response = json.dumps({
    "correct": True,
    "partial": False,
    "confidence": 0.9,
    "concepts_demonstrated": ["recursion", "loops"],
    "concepts_misunderstood": ["variables"]
})
result = parse_evaluation_response(response, module_concepts)
assert result.correct is True
assert result.partial is False
assert result.confidence == 0.9
assert result.concepts_demonstrated == ["recursion", "loops"]
assert result.concepts_misunderstood == ["variables"]
print("Test 1 passed: Valid JSON parses correctly")


# Test 2: Filters non-canonical concepts
module_concepts = ["recursion", "loops"]
response = json.dumps({
    "correct": True,
    "partial": False,
    "confidence": 0.8,
    "concepts_demonstrated": ["recursion", "unknown_concept"],
    "concepts_misunderstood": ["loops", "nonexistent"]
})
result = parse_evaluation_response(response, module_concepts)
assert result.concepts_demonstrated == ["recursion"]
assert result.concepts_misunderstood == ["loops"]
print("Test 2 passed: Filters non-canonical concepts")


# Test 3: Handles markdown code fences
module_concepts = ["arrays"]
response = '```json\n{"correct": true, "partial": false, "confidence": 0.7, "concepts_demonstrated": ["arrays"], "concepts_misunderstood": []}\n```'
result = parse_evaluation_response(response, module_concepts)
assert result.correct is True
assert result.confidence == 0.7
assert result.concepts_demonstrated == ["arrays"]
print("Test 3 passed: Handles markdown code fences")


# Test 4: Handles code fences without language tag
module_concepts = ["stacks"]
response = '```\n{"correct": false, "partial": true, "confidence": 0.4, "concepts_demonstrated": [], "concepts_misunderstood": ["stacks"]}\n```'
result = parse_evaluation_response(response, module_concepts)
assert result.correct is False
assert result.partial is True
assert result.concepts_misunderstood == ["stacks"]
print("Test 4 passed: Handles code fences without language tag")


# Test 5: Invalid JSON returns DEFAULT_EVALUATION
result = parse_evaluation_response("not valid json at all", ["a"])
assert result.correct == DEFAULT_EVALUATION.correct
assert result.partial == DEFAULT_EVALUATION.partial
assert result.confidence == DEFAULT_EVALUATION.confidence
assert result.concepts_demonstrated == DEFAULT_EVALUATION.concepts_demonstrated
assert result.concepts_misunderstood == DEFAULT_EVALUATION.concepts_misunderstood
print("Test 5 passed: Invalid JSON returns DEFAULT_EVALUATION")


# Test 6: Missing field returns DEFAULT_EVALUATION
response = json.dumps({"correct": True, "partial": False})  # missing confidence and concepts
result = parse_evaluation_response(response, ["a"])
assert result.correct == DEFAULT_EVALUATION.correct
print("Test 6 passed: Missing field returns DEFAULT_EVALUATION")


# Test 7: Clamps confidence above 1.0
module_concepts = ["x"]
response = json.dumps({
    "correct": True,
    "partial": False,
    "confidence": 1.5,
    "concepts_demonstrated": ["x"],
    "concepts_misunderstood": []
})
result = parse_evaluation_response(response, module_concepts)
assert result.confidence == 1.0
print("Test 7 passed: Clamps confidence above 1.0")


# Test 8: Clamps confidence below 0.0
module_concepts = ["y"]
response = json.dumps({
    "correct": False,
    "partial": True,
    "confidence": -0.3,
    "concepts_demonstrated": [],
    "concepts_misunderstood": ["y"]
})
result = parse_evaluation_response(response, module_concepts)
assert result.confidence == 0.0
print("Test 8 passed: Clamps confidence below 0.0")


# Test 9: Empty string returns DEFAULT_EVALUATION
result = parse_evaluation_response("", ["a"])
assert result.correct == DEFAULT_EVALUATION.correct
print("Test 9 passed: Empty string returns DEFAULT_EVALUATION")


# Test 10: None-like types in concepts don't crash
module_concepts = ["valid"]
response = json.dumps({
    "correct": True,
    "partial": False,
    "confidence": 0.5,
    "concepts_demonstrated": [None, "valid", 123],
    "concepts_misunderstood": ["valid", None]
})
result = parse_evaluation_response(response, module_concepts)
assert result.concepts_demonstrated == ["valid"]
assert result.concepts_misunderstood == ["valid"]
print("Test 10 passed: Non-string concepts filtered out by canonical check")


# Test 11: Code fence with extra whitespace
module_concepts = ["pointers"]
response = '  ```json  \n  {"correct": true, "partial": false, "confidence": 0.6, "concepts_demonstrated": ["pointers"], "concepts_misunderstood": []}  \n  ```  '
result = parse_evaluation_response(response, module_concepts)
assert result.correct is True
assert result.concepts_demonstrated == ["pointers"]
print("Test 11 passed: Code fence with extra whitespace")


# Test 12: TypeError when concepts field is not iterable
module_concepts = ["recursion"]
response = json.dumps({
    "correct": True,
    "partial": False,
    "confidence": 0.8,
    "concepts_demonstrated": 42,
    "concepts_misunderstood": []
})
# Integer is not iterable — should return DEFAULT_EVALUATION
result = parse_evaluation_response(response, module_concepts)
assert result.correct == DEFAULT_EVALUATION.correct
assert result.partial == DEFAULT_EVALUATION.partial
print("Test 12 passed: Non-iterable concepts_demonstrated returns DEFAULT_EVALUATION")


print("\nAll evaluation parsing tests passed!")
