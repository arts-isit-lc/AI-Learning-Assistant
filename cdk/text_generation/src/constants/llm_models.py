# Hardcoded LLM model configurations
# This data structure contains the currently supported LLM models

LLM_MODELS = {
    'LLAMA_70B': {
        'id': 'meta.llama3-70b-instruct-v1:0',
        'name': 'Llama 3 70B Instruct',
        'provider': 'Meta',
        'description': 'Large language model optimized for instruction following and educational conversations'
    },
    'CLAUDE_3_SONNET': {
        'id': 'anthropic.claude-3-sonnet-20240229-v1:0',
        'name': 'Claude 3 Sonnet',
        'provider': 'Anthropic',
        'description': 'Balanced model with strong reasoning capabilities and safety features'
    }
}

# Default model ID
DEFAULT_LLM_MODEL_ID = LLM_MODELS['LLAMA_70B']['id']

# Helper function to get model name by ID
def get_model_name_by_id(model_id):
    for model in LLM_MODELS.values():
        if model['id'] == model_id:
            return model['name']
    return 'Unknown Model'

# Helper function to validate model ID
def is_valid_model_id(model_id):
    return any(model['id'] == model_id for model in LLM_MODELS.values())