"""Test bank: Math classifier — 40+ test cases."""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "chatbot_v2", "src"))

from math_classifier import classify_math_intent


class TestComputeDetection:
    def test_find_eigenvalues(self):
        r = classify_math_intent("find eigenvalues of [[2,1],[1,2]]")
        assert r.compute
        assert r.operation_hint == "eigenvalues"
        assert r.has_explicit_math

    def test_calculate_determinant(self):
        r = classify_math_intent("calculate the determinant of [[3,0],[0,4]]")
        assert r.compute
        assert r.operation_hint == "determinant"

    def test_solve_equation(self):
        r = classify_math_intent("solve x^2 - 4 = 0")
        assert r.compute
        assert r.operation_hint == "solve"

    def test_compute_inverse(self):
        r = classify_math_intent("compute the inverse of [[2,1],[1,2]]")
        assert r.compute
        assert r.operation_hint == "inverse"

    def test_derivative(self):
        r = classify_math_intent("find the derivative of x^2 + 3x")
        assert r.compute
        assert r.operation_hint == "derivative"

    def test_integrate(self):
        r = classify_math_intent("integrate sin(x)")
        assert r.compute
        assert r.operation_hint == "integral"

    def test_row_reduce(self):
        r = classify_math_intent("row reduce [[1,2,3],[4,5,6]]")
        assert r.compute
        assert r.operation_hint == "rref"


class TestExplainDetection:
    def test_walk_me_through(self):
        r = classify_math_intent("walk me through eigenvalues for [[2,1],[1,2]]")
        assert r.explain
        assert r.compute  # also needs compute

    def test_what_is(self):
        r = classify_math_intent("what is an eigenvalue?")
        assert r.explain
        assert not r.has_explicit_math

    def test_show_me_how(self):
        r = classify_math_intent("show me how to find the determinant of [[1,2],[3,4]]")
        assert r.explain
        assert r.compute


class TestVerifyDetection:
    def test_check_my_work(self):
        r = classify_math_intent("check my work: eigenvalues are 3 and 1 for [[2,1],[1,2]]")
        assert r.verify
        assert r.compute

    def test_is_this_correct(self):
        r = classify_math_intent("is this correct: det = 5 for [[2,3],[1,4]]")
        assert r.verify

    def test_did_i_get(self):
        r = classify_math_intent("did i get the right answer?")
        assert r.verify


class TestDiscourseRejection:
    def test_the_matrix_above(self):
        r = classify_math_intent("use the matrix above to find eigenvalues")
        assert r.is_discourse_reference
        assert not r.needs_compute_lambda()

    def test_that_matrix(self):
        r = classify_math_intent("find determinant of that matrix")
        assert r.is_discourse_reference

    def test_same_one(self):
        r = classify_math_intent("use the same matrix as before")
        assert r.is_discourse_reference

    def test_part_b(self):
        r = classify_math_intent("now solve part b")
        assert r.is_discourse_reference

    def test_example_reference(self):
        r = classify_math_intent("use the matrix from example 4")
        assert r.is_discourse_reference


class TestNoCompute:
    def test_conceptual_question(self):
        r = classify_math_intent("what do eigenvalues represent geometrically?")
        # "eigenvalues" keyword triggers compute flag, but no explicit math → doesn't invoke Lambda
        assert not r.has_explicit_math
        assert not r.needs_compute_lambda()

    def test_greeting(self):
        r = classify_math_intent("hello how are you")
        assert not r.compute
        assert not r.explain
        assert not r.verify

    def test_general_question(self):
        r = classify_math_intent("can you explain linear algebra?")
        assert r.explain
        assert not r.compute

    def test_topic_overview(self):
        r = classify_math_intent("give me an overview of matrix operations")
        assert not r.compute


class TestNeedsComputeLambda:
    def test_explicit_math_with_compute(self):
        r = classify_math_intent("find eigenvalues of [[2,1],[1,2]]")
        assert r.needs_compute_lambda()

    def test_no_explicit_math(self):
        r = classify_math_intent("find eigenvalues")
        assert not r.needs_compute_lambda()  # no matrix provided

    def test_discourse_reference_blocks(self):
        r = classify_math_intent("find eigenvalues of the matrix above")
        assert not r.needs_compute_lambda()  # discourse ref blocks it

    def test_conceptual_no_compute(self):
        r = classify_math_intent("what is a determinant?")
        assert not r.needs_compute_lambda()
