from aws_lambda_powertools import Logger

logger = Logger(service="event-notification")


@logger.inject_lambda_context(clear_state=True)
def lambda_handler(event, context):
    logger.info("Event received", extra={"event": event})
    try:
        # Extract arguments from the AppSync payload
        arguments = event.get("arguments", {})
        request_id = arguments.get("request_id", "DefaultRequestId")
        message = arguments.get("message", "Default message")

        # Log the extracted values for debugging
        logger.info("Extracted arguments", extra={"request_id": request_id, "notification_message": message})

        # Return the values back to AppSync
        return {
            "request_id": request_id,
            "message": message
        }

    except Exception as e:
        logger.exception("Error processing event notification")
        return {
            "error": str(e)
        }
