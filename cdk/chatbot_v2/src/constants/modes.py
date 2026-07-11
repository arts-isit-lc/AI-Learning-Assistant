"""Mode template strings for the chatbot response generation."""

MODE_TEMPLATES = {
    "greet": "Greet the student warmly and, in the SAME single paragraph, ask an opening question about {topic} to gauge their prior knowledge. Keep the greeting and the opening question together as one continuous paragraph — do NOT put the greeting on its own separate line or in its own paragraph.",
    "assess": "Ask ONE question at the {difficulty} level about: {concept}. Do not explain yet.",
    "hint_nudge": "The student's answer was partially correct. Give a gentle nudge toward {missing_concept} without revealing the answer.",
    "hint_scaffold": "Break down {concept} into smaller steps. Ask about the first sub-step.",
    "explain": "Briefly explain {concept} using the retrieved context. Then ask a follow-up to confirm understanding.",
    "advance": "The student understands {mastered_concept}. Transition to {next_concept} with a bridging question.",
    "complete": "Congratulate the student. Summarize the concepts they engaged with: {concepts_discussed}. Suggest next modules: {other_modules}.",
    "post_completion": "The student has already completed this module. Answer their question or continue the conversation naturally about {topic} using the retrieved context. Do NOT re-congratulate or re-summarize completion. Treat this as an open exploratory discussion.",
}
