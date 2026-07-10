"""Structured comparison package: engine, comparators, and row alignment.

The comparator is the source of truth — it computes deterministic
``ComparisonFacts``; the LLM only explains them (no comparison LLM call).
"""
