import secrets
import string
from aws_lambda_powertools import Logger

logger = Logger(service="chatbot-v2")

GUARDRAIL_REDIRECT_INPUT = "I appreciate your question, but let's stay focused on the course material. What would you like to explore about the module topic?"
GUARDRAIL_REDIRECT_OUTPUT = "Let me rephrase my response to stay focused on the course material."
# Shown when the guardrail service itself errors and GUARDRAIL_FAIL_CLOSED is on:
# we return this safe message instead of regenerating without guardrails (#11).
GUARDRAIL_SERVICE_ERROR_MESSAGE = "I'm having trouble responding right now. Please try again in a moment."


def load_guardrail_config(ssm_client, id_param: str, version_param: str) -> tuple[str, str]:
    """Load guardrail_id and guardrail_version from SSM.
    Returns ("", "") on failure — empty strings signal 'proceed without guardrails'."""
    if not id_param or not version_param:
        return ("", "")
    try:
        guardrail_id = ssm_client.get_parameter(Name=id_param, WithDecryption=True)["Parameter"]["Value"]
        guardrail_version = ssm_client.get_parameter(Name=version_param, WithDecryption=True)["Parameter"]["Value"]
        return (guardrail_id, guardrail_version)
    except Exception:
        logger.exception("Failed to load guardrail config from SSM")
        return ("", "")


def wrap_user_message(message: str) -> str:
    """Wrap user message in Bedrock Guardrail input tags with 8-char random alphanumeric suffix.
    Output: <amazon-bedrock-guardrails-guardContent_{S}>{message}</amazon-bedrock-guardrails-guardContent_{S}>
    """
    suffix = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8))
    tag = f"amazon-bedrock-guardrails-guardContent_{suffix}"
    return f"<{tag}>{message}</{tag}>"


def handle_guardrail_error(error: Exception, guardrail_id: str) -> dict | None:
    """Classify guardrail errors:
    - GUARDRAIL_INTERVENED (input) → return safe redirect message dict
    - GUARDRAIL_INTERVENED (output) → return safe redirect message dict
    - Service error → return None (caller retries without guardrails)
    """
    err_msg = str(error)
    if "GUARDRAIL_INTERVENED" in err_msg or "GuardrailIntervention" in err_msg:
        if "input" in err_msg.lower():
            return {"message": GUARDRAIL_REDIRECT_INPUT, "blocked": True, "type": "input"}
        return {"message": GUARDRAIL_REDIRECT_OUTPUT, "blocked": True, "type": "output"}
    # Service error — not an intervention
    logger.warning("Guardrail service error (not intervention)", extra={"guardrail_id": guardrail_id, "error": err_msg})
    return None


def build_intervention_result(block_type: str) -> dict:
    """Build the blocked-turn result for a guardrail intervention detected via a
    STREAM SIGNAL (ConverseStream sets stopReason='guardrail_intervened' rather
    than raising). Mirrors the dict shape returned by handle_guardrail_error so
    every downstream path (main.handler) treats interventions identically,
    regardless of whether they surfaced as an exception (InvokeModel) or a
    stream signal (ConverseStream).

    Args:
        block_type: "input" (user message blocked) or "output" (model response
            blocked). Anything other than "input" is treated as an output block.
    """
    if block_type == "input":
        return {"message": GUARDRAIL_REDIRECT_INPUT, "blocked": True, "type": "input"}
    return {"message": GUARDRAIL_REDIRECT_OUTPUT, "blocked": True, "type": "output"}
