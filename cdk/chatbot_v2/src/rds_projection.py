"""RDS message projection — writes messages to the relational database.

This module treats RDS as a downstream projection of the canonical DynamoDB
message store. Writes are best-effort: failures are logged but never block
the response to the student.

Architecture note (Phase 1 — transitional):
  DynamoDB = source of truth (canonical message log)
  RDS = synchronous projection (for UI session history display)

Phase 2 will replace this synchronous write with a DynamoDB Stream → Lambda
projection, at which point this module is removed.
"""

from aws_lambda_powertools import Logger

logger = Logger(service="chatbot-v2")


def persist_message_to_rds(
    connection,
    session_id: str,
    message_content: str,
    student_sent: bool,
) -> None:
    """Insert a message into the RDS Messages table and update session timestamp.

    Best-effort: logs errors but never raises. The caller should wrap this in
    a try/except as an additional safety net.

    Args:
        connection: Active psycopg2 connection to RDS via Proxy.
        session_id: The session this message belongs to.
        message_content: The message text.
        student_sent: True if the student wrote it, False if AI generated it.
    """
    try:
        cur = connection.cursor()

        # Insert message with a server-generated UUID
        cur.execute(
            """INSERT INTO "Messages" (message_id, session_id, student_sent, message_content, time_sent)
               VALUES (uuid_generate_v4(), %s, %s, %s, CURRENT_TIMESTAMP)""",
            (session_id, student_sent, message_content),
        )

        # Update session last_accessed
        cur.execute(
            """UPDATE "Sessions" SET last_accessed = CURRENT_TIMESTAMP WHERE session_id = %s""",
            (session_id,),
        )

        connection.commit()
        cur.close()
    except Exception:
        logger.exception(
            "RDS message projection failed (best-effort)",
            extra={"session_id": session_id, "student_sent": student_sent},
        )
        try:
            connection.rollback()
        except Exception:
            pass


def log_engagement(
    connection,
    email: str,
    course_id: str,
    module_id: str,
    engagement_type: str,
) -> None:
    """Insert a User_Engagement_Log record.

    Replicates the engagement logging previously done by studentFunction's
    create_message and create_ai_message routes.

    Best-effort: logs errors but never raises.

    Args:
        connection: Active psycopg2 connection to RDS via Proxy.
        email: Student's email (used to look up user_id and enrolment_id).
        course_id: The course context.
        module_id: The module context.
        engagement_type: Description string (e.g., 'message creation', 'AI message creation').
    """
    if not email:
        logger.warning("Cannot log engagement: email not available")
        return

    try:
        cur = connection.cursor()
        cur.execute(
            """INSERT INTO "User_Engagement_Log" (log_id, user_id, course_id, module_id, enrolment_id, timestamp, engagement_type)
               SELECT uuid_generate_v4(), e.user_id, %s, %s, e.enrolment_id, CURRENT_TIMESTAMP, %s
               FROM "Enrolments" e
               JOIN "Users" u ON e.user_id = u.user_id
               WHERE u.user_email = %s AND e.course_id = %s
               LIMIT 1""",
            (course_id, module_id, engagement_type, email, course_id),
        )
        connection.commit()
        cur.close()
    except Exception:
        logger.exception(
            "Engagement logging failed (best-effort)",
            extra={"email": email, "course_id": course_id, "engagement_type": engagement_type},
        )
        try:
            connection.rollback()
        except Exception:
            pass
