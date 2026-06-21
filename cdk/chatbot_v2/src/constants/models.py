"""Model IDs and configuration thresholds for the Chatbot V2 Lambda."""

# Response generation model (Claude 3 Sonnet)
RESPONSE_MODEL_ID = "anthropic.claude-3-sonnet-20240229-v1:0"
RESPONSE_MAX_TOKENS = 4000

# Evaluation model (Claude 3 Haiku — cheaper, faster)
EVAL_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"
EVAL_MAX_TOKENS = 500

# Completion thresholds (configurable)
MIN_INTERACTIONS_FOR_COMPLETION = 5
MIN_CONCEPTS_DISCUSSED_FOR_COMPLETION = 3
MIN_ENGAGEMENT_SCORE_FOR_COMPLETION = 0.5

# Engagement score increments
ENGAGEMENT_CORRECT_INCREMENT = 0.2
ENGAGEMENT_PARTIAL_WITH_CONCEPTS_INCREMENT = 0.1
ENGAGEMENT_SCORE_CAP = 1.0

# Concept mastery threshold (demonstrations/exposures ratio)
MASTERY_DEMONSTRATION_RATIO = 0.6
