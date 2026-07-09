# Hardcoded LLM model configurations
# This data structure contains the currently supported LLM models

LLM_MODELS = {
    'LLAMA_70B': {
        'id': 'meta.llama3-70b-instruct-v1:0',
        'name': 'Llama 3 70B Instruct',
        'provider': 'Meta',
        'description': 'Large language model optimized for instruction following and educational conversations'
    },
    'CLAUDE_SONNET_4_5': {
        # Geo-US cross-Region inference profile (ca-central-1 has no in-Region
        # 4.5 access; routes to US+Canada only; zero-data-retention account).
        'id': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'name': 'Claude Sonnet 4.5',
        'provider': 'Anthropic',
        'description': 'High-capability model with strong reasoning, coding, and safety features'
    }
}

# Default model ID for new courses and the instructor Settings dropdown.
# Llama 3 70B remains a selectable option pending a future replacement decision.
DEFAULT_LLM_MODEL_ID = LLM_MODELS['CLAUDE_SONNET_4_5']['id']

# Helper function to get model name by ID
def get_model_name_by_id(model_id):
    for model in LLM_MODELS.values():
        if model['id'] == model_id:
            return model['name']
    return 'Unknown Model'

# Helper function to validate model ID
def is_valid_model_id(model_id):
    return any(model['id'] == model_id for model in LLM_MODELS.values())