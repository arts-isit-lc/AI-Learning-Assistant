"""Formula comparison package: LaTeX normalization, lexing, and comparison.

Tier 1 (this package) is purely lexical — normalize -> lex -> structural profile —
with no SymPy and no I/O, so it always produces a comparison. Tier 2 (symbolic
equivalence via math_compute) is a separate, deferred phase.
"""
