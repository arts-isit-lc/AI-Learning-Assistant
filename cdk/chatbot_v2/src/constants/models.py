"""Model IDs and configuration thresholds for the Chatbot V2 Lambda."""

# Response generation model (Claude Sonnet 4.5 via Geo-US cross-Region inference).
# ca-central-1 has no in-Region access to the 4.5 family; the "us." inference
# profile routes to US+Canada Regions only. Account is set to zero data
# retention, so no prompt/response data is persisted in any Region.
RESPONSE_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
RESPONSE_MAX_TOKENS = 4000

# Evaluation model (Claude Haiku 4.5 — cheaper, faster; same Geo-US profile family)
EVAL_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
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
