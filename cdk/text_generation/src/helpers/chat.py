import boto3, json, re, secrets, string
from langchain_aws import ChatBedrock
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from langchain_classic.chains import create_retrieval_chain
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_community.chat_message_histories import DynamoDBChatMessageHistory
from aws_lambda_powertools import Logger
from constants.system_prompt import SYSTEM_LEVEL_PROMPT

logger = Logger(service="text-generation")


def create_dynamodb_history_table(table_name: str) -> bool:
    """
    Create a DynamoDB table to store the session history if it doesn't already exist.

    Args:
    table_name (str): The name of the DynamoDB table to create.

    Returns:
    None
    
    If the table already exists, this function does nothing. Otherwise, it creates a 
    new table with a key schema based on 'SessionId'.
    """
    # Get the service resource and client.
    dynamodb_resource = boto3.resource("dynamodb")
    dynamodb_client = boto3.client("dynamodb")
    
    # Retrieve the list of tables that currently exist.
    existing_tables = []
    exclusive_start_table_name = None
    
    while True:
        if exclusive_start_table_name:
            response = dynamodb_client.list_tables(ExclusiveStartTableName=exclusive_start_table_name)
        else:
            response = dynamodb_client.list_tables()
        
        existing_tables.extend(response.get('TableNames', []))
        
        if 'LastEvaluatedTableName' in response:
            exclusive_start_table_name = response['LastEvaluatedTableName']
        else:
            break
    
    if table_name not in existing_tables:  # Create a new table if it doesn't exist.
        # Create the DynamoDB table.
        table = dynamodb_resource.create_table(
            TableName=table_name,
            KeySchema=[{"AttributeName": "SessionId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "SessionId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        
        # Wait until the table exists.
        table.meta.client.get_waiter("table_exists").wait(TableName=table_name)

# ARCH-4: Cache for ChatBedrock instances per model ID
_llm_cache = {}

def get_bedrock_llm(
    bedrock_llm_id: str,
    temperature: float = 0,
    client=None,
    guardrail_id: str = "",
    guardrail_version: str = "",
) -> ChatBedrock:
    """
    Retrieve a cached Bedrock LLM instance based on the provided model ID.
    When guardrail params are non-empty, include the guardrails dict in the constructor.
    Reuses the global bedrock_runtime client if provided.
    """
    cache_key = f"{bedrock_llm_id}:{temperature}:{guardrail_id}:{guardrail_version}"
    if cache_key not in _llm_cache:
        model_kwargs = {"temperature": temperature}
        if "claude" in bedrock_llm_id.lower():
            model_kwargs["max_tokens"] = 4000

        kwargs = {"model_id": bedrock_llm_id, "model_kwargs": model_kwargs, "streaming": True}
        if client:
            kwargs["client"] = client
        if guardrail_id and guardrail_version:
            kwargs["guardrails"] = {
                "guardrailIdentifier": guardrail_id,
                "guardrailVersion": guardrail_version,
                "trace": True,
            }
        _llm_cache[cache_key] = ChatBedrock(**kwargs)
    return _llm_cache[cache_key]

def get_other_module_names(course_id: str, current_module_id: str, connection) -> list[str]:
    """
    Retrieve all other module names in the same course, excluding the current module.

    Args:
    course_id (str): The course ID.
    current_module_id (str): The current module ID.
    connection: The active database connection.

    Returns:
    list[str]: A list of other module names in the same course.
    """
    if connection is None:
        logger.warning("No database connection available.")
        return []

    try:
        cur = connection.cursor()

        query = """
            SELECT cm.module_name
            FROM "Course_Modules" cm
            INNER JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
            WHERE cc.course_id = %s AND cm.module_id != %s;
        """
        cur.execute(query, (course_id, current_module_id))
        results = cur.fetchall()
        connection.commit()
        cur.close()

        other_modules = [row[0] for row in results]
        logger.info(
            "Other modules fetched",
            extra={"course_id": course_id, "module_count": len(other_modules)},
        )
        return other_modules

    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.exception(
            "Error fetching other module names",
            extra={"course_id": course_id, "module_id": current_module_id},
        )
        return []

def get_student_query(raw_query: str) -> str:
    """
    Format the student's raw query into a specific template suitable for processing.

    Args:
    raw_query (str): The raw query input from the student.

    Returns:
    str: The formatted query string ready for further processing.
    """
    student_query = f"""
    user
    {raw_query}
    
    """
    return student_query

def get_initial_student_query(topic: str) -> str:
    """
    Generate an initial query for the student to interact with the system. 
    The query asks the student to greet the system and then requests a question related to a specified topic.

    Args:
    topic (str): The topic for which the initial question should be generated.

    Returns:
    str: The formatted initial query string for the student.
    """
    student_query = f"""
    user
    Greet me and then ask me a question related to the topic: {topic}. 
    """
    return student_query

def wrap_user_message_with_guardrail_tags(user_message: str) -> str:
    """Wrap user message in Bedrock Guardrail input tags.
    A random alphanumeric tagSuffix is generated per request to prevent injection."""
    tag_suffix = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8))
    open_tag = f"<amazon-bedrock-guardrails-guardContent_{tag_suffix}>"
    close_tag = f"</amazon-bedrock-guardrails-guardContent_{tag_suffix}>"
    return f"{open_tag}{user_message}{close_tag}"


def get_module_topics(module_id: str, connection) -> str:
    """
    Fetch aggregated module topics from Course_Modules.generated_topics.
    Returns a formatted string for prompt injection, or empty string if unavailable.

    Args:
        module_id: The module ID to fetch topics for.
        connection: Active database connection.

    Returns:
        Formatted topic string for system prompt injection, or empty string.
    """
    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT generated_topics FROM "Course_Modules"
            WHERE module_id = %s;
        """, (module_id,))
        result = cur.fetchone()
        cur.close()

        if not result or not result[0]:
            return ""

        # `generated_topics` may be stored as:
        #   - a bare JSON array of topic strings (written by generateTopics.js), or
        #   - a dict with "topics"/"learning_objectives" keys (legacy shape), or
        #   - a JSON string (or double-encoded JSON string) of either of the above.
        # Normalize all of these so topic injection works regardless of writer.
        raw = result[0]
        for _ in range(2):  # unwrap up to one layer of double-encoding
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except (ValueError, TypeError):
                    return ""
            else:
                break

        if isinstance(raw, list):
            topics = raw
            objectives = []
        elif isinstance(raw, dict):
            topics = raw.get("topics", [])
            objectives = raw.get("learning_objectives", [])
        else:
            return ""

        if not isinstance(topics, list):
            topics = []
        if not isinstance(objectives, list):
            objectives = []

        if not topics:
            return ""

        # Cap at 7 each
        topics = topics[:7]
        objectives = objectives[:7]

        section = "Primary concepts covered by this module:\n"
        section += "\n".join(f"- {t}" for t in topics)
        if objectives:
            section += "\n\nKey learning objectives:\n"
            section += "\n".join(f"- {o}" for o in objectives)
        section += "\n\nWhen answering questions, prioritize explanations that relate to these concepts."
        return section

    except Exception as e:
        logger.warning(
            "Failed to fetch module topics",
            extra={"module_id": module_id, "error": str(e)},
        )
        return ""


def should_inject_topics(module_prompt: str) -> bool:
    """
    Determine if extracted topics should be injected into the system prompt.
    Inject only when no module prompt exists — if the instructor wrote one, trust it.

    Args:
        module_prompt: The instructor's module-level prompt string.

    Returns:
        True if topics should be injected, False otherwise.
    """
    return not module_prompt or not module_prompt.strip()


def get_response_streaming(
    query: str,
    topic: str,
    llm: ChatBedrock,
    history_aware_retriever,
    table_name: str,
    session_id: str,
    course_system_prompt: str,
    module_prompt: str,
    course_id: str,
    module_id: str,
    connection,
    chunk_callback=None,
    done_callback=None,
) -> dict:
    """
    ARCH-1: Streaming version of get_response. Sends chunks via callback
    (AppSync mutation) as they arrive, then returns the final result.
    """
    # Topic injection: add module topics when no module prompt exists
    module_topics_section = ""
    if should_inject_topics(module_prompt):
        module_topics_section = get_module_topics(module_id, connection)

    system_prompt = (
        f"{SYSTEM_LEVEL_PROMPT}\n"
        f"Your job is to help the student understand the concepts in the course reading on topic: {topic}.\n"
        f"{module_topics_section}\n"
        f"{course_system_prompt}\n"
        f"{module_prompt}\n"
        "\nRetrieved Context:\n"
        "{context}"
    )

    

    # Wrap user message in guardrail input tags so only the user content is evaluated
    tagged_query = wrap_user_message_with_guardrail_tags(query)

    qa_prompt = ChatPromptTemplate.from_messages(
        [
            ("system", system_prompt),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ]
    )
    question_answer_chain = create_stuff_documents_chain(llm, qa_prompt)
    rag_chain = create_retrieval_chain(history_aware_retriever, question_answer_chain)

    conversational_rag_chain = RunnableWithMessageHistory(
        rag_chain,
        lambda session_id: DynamoDBChatMessageHistory(
            table_name=table_name,
            session_id=session_id
        ),
        input_messages_key="input",
        history_messages_key="chat_history",
        output_messages_key="answer",
    )

    # Stream the response, sending chunks via callback
    import time
    t_stream_start = time.time()
    full_response = ""
    chunk_buffer = ""
    CHUNK_SIZE = 80
    first_chunk_logged = False
    chunk_count = 0

    try:
        for chunk in conversational_rag_chain.stream(
            {"input": tagged_query},
            config={"configurable": {"session_id": session_id}},
        ):
            answer_chunk = chunk.get("answer", "")
            if answer_chunk:
                if not first_chunk_logged:
                    logger.info(
                        "First token arrived",
                        extra={"time_to_first_token_ms": round((time.time() - t_stream_start) * 1000)},
                    )
                    first_chunk_logged = True
                full_response += answer_chunk
                chunk_buffer += answer_chunk
                chunk_count += 1

                if len(chunk_buffer) >= CHUNK_SIZE and chunk_callback:
                    chunk_callback(chunk_buffer)
                    chunk_buffer = ""

        # Send any remaining buffer
        if chunk_buffer and chunk_callback:
            chunk_callback(chunk_buffer)

        # Signal streaming is done
        if done_callback:
            done_callback()

        stream_latency = time.time() - t_stream_start
        logger.info(
            "Streaming complete",
            extra={
                "stream_latency_ms": round(stream_latency * 1000),
                "response_length": len(full_response),
                "chunk_count": chunk_count,
            },
        )

    except Exception:
        logger.exception(
            "Error during streaming",
            extra={"session_id": session_id, "partial_response_length": len(full_response)},
        )
        if done_callback:
            done_callback()
        if not full_response:
            full_response = "I'm sorry, I wasn't able to generate a response. Please try again."

    if not full_response:
        full_response = "I'm sorry, I wasn't able to generate a response. Please try again."

    return get_llm_output(full_response, course_id, module_id, connection)

def get_llm_output(
    response: str,
    course_id: str,
    module_id: str,
    connection
    ) -> dict:
    """
    Processes the response from the LLM to determine if competency has been achieved.

    Args:
    response (str): The response generated by the LLM.

    Returns:
    dict: A dictionary containing the processed output from the LLM and a boolean 
    flag indicating whether competency has been achieved.
    """

    # competion_sentence = " Congratulations! You have achieved competency over this module! Please try other modules to continue your learning journey! :)"
    
    # New completion phrase to detect
    full_completion_phrase = "Thank you for chatting with me about this topic, you are ready to go discuss this with your class.";
    completion_phrase = "you are ready to go discuss this with your class"
    response_lower = response.lower()
    
    if completion_phrase not in response_lower:
        return dict(
            llm_output=response,
            llm_verdict=False
        )
    
    elif completion_phrase in response_lower:
        sentences = split_into_sentences(response)
        
        for i in range(len(sentences)):
            
            if completion_phrase in sentences[i].lower():
                llm_response=' '.join(sentences[0:i-1])
                
                if sentences[i-1][-1] == '?':
                    return dict(
                        llm_output=llm_response,
                        llm_verdict=False
                    )
                else:
                    other_modules = get_other_module_names(course_id, module_id, connection)
                    recommendation = ""
                    if other_modules:
                        recommendation = " You may also want to explore these modules next: " + ", ".join(other_modules) + "."
                    return dict(
                        llm_output=llm_response + full_completion_phrase + recommendation,
                        llm_verdict=True
                    )
    
    # Fallback check for partial phrase match
    elif "ready to go discuss this with your class" in response.lower():
        other_modules = get_other_module_names(course_id, module_id, connection)
        recommendation = ""
        if other_modules:
            recommendation = " You may also want to explore these modules next: " + ", ".join(other_modules) + "."
        
        return dict(
            llm_output=response + full_completion_phrase + recommendation,
            llm_verdict=True
        )
    
    # Default case
    return dict(
        llm_output=response,
        llm_verdict=False
    )

def split_into_sentences(paragraph: str) -> list[str]:
    """
    Splits a given paragraph into individual sentences using a regular expression to detect sentence boundaries.

    Args:
    paragraph (str): The input text paragraph to be split into sentences.

    Returns:
    list: A list of strings, where each string is a sentence from the input paragraph.

    This function uses a regular expression pattern to identify sentence boundaries, such as periods, question marks, 
    or exclamation marks, and avoids splitting on abbreviations (e.g., "Dr." or "U.S.") by handling edge cases. The 
    resulting list contains sentences extracted from the input paragraph.
    """
    # Regular expression pattern
    sentence_endings = r'(?<!\w\.\w.)(?<![A-Z][a-z]\.)(?<=\.|\?|\!)\s'
    sentences = re.split(sentence_endings, paragraph)
    return sentences
