# Chatbot Optimizations

Analysis and recommendations for improving the AI chatbot's performance and user experience. The chatbot's slowness is fundamentally architectural — the synchronous request/response pattern with 2-3 sequential LLM calls means the student always waits 5-20+ seconds.

## Chatbot Architecture Deep Dive — Why It Feels Slow

The chatbot's perceived slowness is primarily architectural, not just a matter of query optimization. Here's the full end-to-end trace of what happens when a student sends a message, with estimated timings.

### End-to-End Timeline: Student Sends a Message (Warm Invocation)

```
FRONTEND (browser)
├─ fetchAuthSession()                                    ~20ms
├─ fetchUserAttributes()                                 ~20ms
├─ [P-7] POST create_message ──┐                         ~200-400ms (parallel with text_gen)
│   ├─ API Gateway routing      │                         ~10ms
│   ├─ Authorizer Lambda        │                         ~30-80ms (Cognito AdminGetUser!)
│   ├─ studentFunction Lambda   │                         ~100-200ms (5 sequential DB queries)
│   └─ Response to frontend     │
└─ POST text_generation ────────┘                         ~5-25 SECONDS (the bottleneck)
    ├─ API Gateway routing                                ~10ms
    ├─ Authorizer Lambda                                  ~30-80ms (Cognito AdminGetUser!)
    └─ TextGenLambdaDockerFunc                            ~5-25 SECONDS
        ├─ initialize_constants()                         ~0ms (warm, cached)
        ├─ get_module_context()                           ~10-15ms (1 DB query)
        ├─ get_allowed_file_ids()                         ~10-15ms (1 DB query)
        ├─ get_bedrock_llm()                              ~5ms (object creation, no API call)
        ├─ get_vectorstore_retriever()                    ~0ms (closure creation)
        │
        ├─ get_response() ─── THE CORE BOTTLENECK ────────~5-20 SECONDS
        │   ├─ Chain construction (prompts, chains)       ~5ms
        │   ├─ conversational_rag_chain.invoke()          ~5-20 SECONDS
        │   │   ├─ DynamoDB: load chat history            ~20-50ms
        │   │   ├─ BEDROCK LLM CALL #1:                   ~2-8 SECONDS
        │   │   │   history-aware retriever
        │   │   │   (reformulates question with context)
        │   │   ├─ retrieve() closure:                    ~500ms-2s
        │   │   │   ├─ Bedrock embedding call             ~200-500ms
        │   │   │   ├─ hybrid_search vector SQL           ~50-200ms
        │   │   │   └─ hybrid_search keyword SQL          ~50-200ms
        │   │   ├─ BEDROCK LLM CALL #2:                   ~2-10 SECONDS
        │   │   │   RAG response generation
        │   │   │   (generates answer from context)
        │   │   └─ DynamoDB: save chat history            ~20-50ms
        │   └─ get_llm_output() (string processing)      ~0ms
        │
        └─ update_session_name()                          ~0ms (returns None on 2nd+ message)
            OR (first message only):                      ~3-8 SECONDS
            ├─ DynamoDB: get_item (chat history)          ~20-50ms
            ├─ BEDROCK LLM CALL #3:                       ~2-8 SECONDS
            │   generate session name
            └─ return session name

FRONTEND (after text_gen returns)
├─ [parallel] PUT update_session_name                     ~200ms
├─ [parallel] POST update_module_score                    ~200ms
└─ POST create_ai_message                                 ~200-400ms
```

### Total Wall Clock Time

| Scenario | Estimated Time |
|----------|---------------|
| Warm, 2nd+ message | **5-20 seconds** |
| Warm, 1st message | **8-28 seconds** |
| Cold start, 1st message | **12-33 seconds** |

### The Fundamental Problem: Synchronous Request/Response with Sequential LLM Calls

The architecture makes the student wait for the ENTIRE pipeline to complete before seeing any response. The dominant cost is:

1. **Bedrock LLM Call #1 (history-aware retriever)**: 2-8 seconds. This reformulates the student's question using chat history. It's a full LLM inference call just to rephrase a question.

2. **Bedrock LLM Call #2 (RAG response)**: 2-10 seconds. This generates the actual answer. The response length directly affects latency — longer answers take longer.

3. **Bedrock LLM Call #3 (session naming, first message only)**: 2-8 seconds. This runs AFTER the response is generated, blocking the return to the frontend.

These three calls are strictly sequential. The student sees nothing until all of them complete.

### Architectural Issues

**Issue 1: The history-aware retriever makes a full LLM call to rephrase every question**

`create_history_aware_retriever` from LangChain takes the student's question + chat history and calls the LLM to produce a "standalone question" that can be used for retrieval without the chat context. This is a full Bedrock inference call (2-8 seconds) that runs BEFORE any retrieval or response generation.

For simple follow-up questions like "tell me more" or "can you explain that?", this is valuable. But for standalone questions (which most student messages are), it's wasted time — the LLM just returns the original question unchanged.

**Issue 2: No streaming — student waits for the complete response**

The Lambda returns the full response as a single JSON payload. The student sees a loading spinner for 5-20 seconds, then the entire response appears at once. Modern chatbots stream tokens as they're generated, giving the user immediate feedback.

Bedrock supports streaming via `invoke_model_with_response_stream`. LangChain supports streaming via `.stream()` instead of `.invoke()`. But the current architecture (API Gateway → Lambda → return JSON) doesn't support streaming responses.

To enable streaming, the architecture would need one of:
- **Lambda Function URLs with response streaming** (simplest)
- **WebSocket API Gateway** (the app already has AppSync for notifications)
- **Server-Sent Events via Lambda response streaming**

This is the single biggest UX improvement possible. Even if the total time doesn't change, perceived latency drops dramatically because the student sees tokens appearing within 1-2 seconds.

**Issue 3: Session naming blocks the response on first message**

`update_session_name()` runs AFTER `get_response()` but BEFORE returning to the frontend. On the first message, it makes a DynamoDB read + a full Bedrock LLM call (2-8 seconds) just to generate a chat title. The student waits for this before seeing the AI's greeting.

This could be moved to the frontend's post-response flow (it already calls `PUT update_session_name` after receiving the text_gen response) or done asynchronously.

**Issue 4: The RAG chain reconstructs everything on every invocation**

Every call to `get_response()` rebuilds the entire LangChain pipeline from scratch:
- Creates `ChatPromptTemplate`
- Creates `create_stuff_documents_chain`
- Creates `create_retrieval_chain`
- Creates `RunnableWithMessageHistory`

These are lightweight Python object constructions (~5ms total), but it means no chain-level caching or optimization across invocations. Not a major issue, but worth noting.

**Issue 5: Chat history grows unbounded**

`DynamoDBChatMessageHistory` loads the ENTIRE chat history on every invocation. As conversations grow longer, this DynamoDB read gets larger and the LLM calls get slower (more tokens in the context window). There's no truncation or summarization of old messages.

For a 20-message conversation, the chat history could be 5,000+ tokens, which:
- Increases DynamoDB read time (larger item)
- Increases LLM Call #1 time (more context to process for question reformulation)
- Increases LLM Call #2 time (more chat history in the prompt)
- Increases Bedrock cost (billed per token)

### What Would Actually Make the Chatbot Feel Fast

In priority order:

1. **Response streaming** — The student sees tokens appearing within 1-2 seconds instead of waiting 5-20 seconds for the complete response. This is the single biggest perceived-latency improvement. Requires architectural change (Lambda response streaming or WebSocket).

2. **Remove or conditionally skip the history-aware retriever LLM call** — For standalone questions (no pronouns referencing previous messages), skip the reformulation and use the raw question directly for retrieval. This saves 2-8 seconds on most messages. Could use a simple heuristic (check for pronouns like "it", "that", "this") or make it configurable.

3. **Move session naming out of the critical path** — Don't block the response return on session name generation. Either do it asynchronously (invoke a separate Lambda) or let the frontend handle it in the post-response flow.

4. **Limit chat history window** — Only send the last N messages (e.g., 10) to the LLM instead of the full history. Keeps LLM call times consistent regardless of conversation length.

5. **The optimizations we've already done (P-1 through P-8)** — VPC endpoint, combined queries, connection reuse, etc. These shave ~200-500ms total, which matters but is dwarfed by the 5-20 second LLM calls.

### Summary

The chatbot's slowness is fundamentally architectural. The synchronous request/response pattern with 2-3 sequential LLM calls means the student always waits 5-20+ seconds. No amount of query optimization or connection reuse will change this — the LLM inference time dominates everything else by 10-100x.

The highest-impact change is response streaming, which doesn't reduce total time but transforms the UX from "wait 15 seconds, see everything" to "see first words in 1-2 seconds, response builds in real-time." This is how ChatGPT, Claude, and every modern chatbot works.

---

## ARCH-1: Switch Text Generation to Lambda Function URL with Response Streaming

This is the single highest-impact change for chatbot UX. It transforms the student experience from "stare at a spinner for 5-20 seconds" to "see the first words in 1-2 seconds, response builds in real-time."

### Why Lambda Function URL

Three options were evaluated:

| Option | Time-to-first-token | Per-request cost | Implementation effort | Auth approach |
|--------|---------------------|------------------|----------------------|---------------|
| Lambda Function URL | ~1-2s | Free | Low | JWT verification in Lambda |
| AppSync WebSocket (existing) | ~1.5-2.5s | ~$0.00005/response | Medium | AppSync auth |
| New WebSocket API Gateway | ~1.5-2.5s | ~$0.000002/response | High | Custom |

Lambda Function URL wins on every axis:
- **Fewest network hops**: Browser → Lambda. No API Gateway routing (~10ms), no separate authorizer Lambda invocation (~30-80ms). The request hits the Lambda directly.
- **Native streaming**: The Lambda writes to a response stream and bytes flow directly to the client. Options 2 and 3 require the Lambda to actively push chunks through a separate service (AppSync mutations or WebSocket API sends), adding per-chunk overhead.
- **Zero per-request cost**: API Gateway REST API charges $3.50/million requests. Function URLs are free. At scale (e.g., 2.4M requests/semester for 1,000 students), this saves ~$8.40/semester — small but it's pure waste eliminated.
- **Simpler implementation**: No new infrastructure. Add a Function URL to the existing Docker Lambda. The streaming logic (Bedrock streaming + writing chunks) is contained within the Lambda.

### Scaling Characteristics

- Lambda Function URLs scale identically to API Gateway-invoked Lambdas — same concurrency pool, same burst limits, same provisioned concurrency options.
- The scaling bottleneck is Bedrock model throughput limits and Lambda concurrent execution limits (default 1,000/account), not the transport layer. All three options hit the same bottleneck.
- JWT verification inside the Lambda (`aws-jwt-verify` with cached JWKS) is actually more efficient at scale than the current separate authorizer Lambda — it eliminates one Lambda invocation per request.

### Auth Without API Gateway Authorizer

The current flow: API Gateway → Authorizer Lambda (fetches Cognito secret, verifies JWT) → Text Gen Lambda.

With Function URL: Browser → Text Gen Lambda (verifies JWT internally).

The `aws-jwt-verify` library (already used by the authorizers) caches the JWKS after the first fetch. On warm invocations, JWT verification is pure local crypto (~5ms, no network call). This is faster than the current authorizer Lambda invocation (~30-80ms including the Cognito AdminGetUser call).

Implementation: Add JWT verification at the top of the text generation handler. The Function URL can use `AWS_IAM` auth type (frontend signs requests with Cognito Identity Pool credentials) or `NONE` auth type with manual JWT verification in the Lambda.

### Rate Limiting / WAF

Function URLs don't have built-in throttling or WAF. For a university course platform with authenticated users, this is unlikely to be a concern. If needed later, add CloudFront in front of the Function URL — it provides WAF integration, is free for the first 10M requests/month, and doesn't lock you in.

### What Changes

**Infrastructure (CDK):**
- Add a Function URL to `TextGenLambdaDockerFunc` with `InvokeMode: RESPONSE_STREAM`
- The existing API Gateway `text_generation` endpoint can remain as a fallback or be removed
- No new Lambda functions, no new services

**Backend (text_generation Lambda):**
- Switch from `return { statusCode: 200, body: json.dumps(...) }` to writing chunks to the Lambda response stream
- Switch Bedrock invocation from `invoke_model` to `invoke_model_with_response_stream` (or LangChain's `.stream()` instead of `.invoke()`)
- Add JWT verification at the top of the handler (using `aws-jwt-verify` or PyJWT + JWKS)
- Move `update_session_name` out of the critical path — either return the response first and run it after, or skip it entirely and let the frontend's existing `PUT update_session_name` handle it

**Frontend (StudentChat.jsx):**
- Switch the `text_generation` fetch from reading a JSON response to reading a streaming response body (`response.body.getReader()`)
- Display tokens as they arrive instead of waiting for the complete response
- The Function URL endpoint replaces the API Gateway endpoint for this one call only

### Estimated Impact

| Metric | Current | With Streaming |
|--------|---------|---------------|
| Time to first visible token | 5-20s | 1-2s |
| Total response time | 5-20s | 5-20s (unchanged) |
| Perceived wait time | 5-20s | 1-2s |
| Student experience | Spinner → wall of text | Tokens appear in real-time |

### Risk Assessment

- **Breaking changes**: None if the API Gateway endpoint is kept as fallback. The frontend switches to the Function URL for text_generation only.
- **Auth**: JWT verification in Lambda is the same crypto as the authorizer, just done in-process. No security regression.
- **Rollback**: If streaming causes issues, the frontend can switch back to the API Gateway endpoint with a config change.
- **No lock-in**: The streaming logic inside the Lambda (Bedrock streaming + chunk writing) works the same regardless of transport. Moving to WebSocket later is straightforward if needed.
- **Docker Lambda compatibility**: Lambda Function URLs with response streaming are supported for Docker image Lambdas (the current `TextGenLambdaDockerFunc` is Docker-based). Confirmed in AWS docs.

---

## ARCH-2: Conditionally Skip History-Aware Retriever Using Lightweight Heuristic

Saves 2-8 seconds on most messages by avoiding a full LLM call that usually returns the question unchanged.

### The Problem

Every student message goes through this chain:

```
Student sends: "What is the main argument in the reading?"

LLM Call #1 (2-8 seconds) — history-aware retriever:
  Input:  full chat history + student question
  Prompt: "Reformulate this question so it can be understood without chat history"
  Output: "What is the main argument in the reading?"  ← UNCHANGED

Embedding + hybrid search (0.5-2 seconds)

LLM Call #2 (2-10 seconds) — RAG response generation
```

LLM Call #1 exists to handle ambiguous follow-ups like "Can you explain that more?" — it reformulates them into standalone questions for better document retrieval. But most student messages in this educational chatbot are already standalone:

- "What is the main argument in the reading?" — standalone
- "I think the author makes a good point about X" — standalone
- "Greet me and ask me a question about the topic: Y" — the system-generated first message, always standalone
- "Can you explain that?" — needs reformulation (references "that")
- "Yes" / "Tell me more" — needs reformulation

The LLM spends 2-8 seconds "reformulating" standalone questions and returns them unchanged. That's the single largest source of wasted time per message.

### Current Code

In `vectorstore.py`, `get_vectorstore_retriever()`:

```python
# This wraps the retriever with an LLM call that runs on EVERY invocation
return create_history_aware_retriever(llm, retriever, contextualize_q_prompt)
```

`create_history_aware_retriever` from LangChain does this internally:
1. Takes the chat history + current question
2. Sends them to the LLM with the contextualization prompt
3. Uses the LLM's output as the search query for the retriever

There's no way to conditionally skip it — it always calls the LLM.

### Recommended Change: Heuristic-Based Bypass

Replace `create_history_aware_retriever` with a custom runnable that checks whether reformulation is needed before calling the LLM.

The heuristic checks for:
1. **Empty chat history** — first message, always standalone
2. **Short ambiguous messages** — "yes", "no", "tell me more", "go on", "explain", "why"
3. **Pronoun-heavy messages without clear nouns** — messages where "it", "that", "this", "they" appear without a clear subject

If the message appears standalone, skip the LLM call and pass it directly to the retriever. If it appears ambiguous, do the LLM reformulation call as before.

```python
import re

# Short ambiguous phrases that need context to be meaningful
AMBIGUOUS_PATTERNS = [
    r'^(yes|no|yeah|nah|sure|okay|ok)[\.\?\!]?$',
    r'^(tell|explain|elaborate|say)\s+(me\s+)?more',
    r'^(go on|continue|keep going|what else)',
    r'^(why|how so|how come|what do you mean)[\?\.\!]?$',
    r'^(can you|could you)\s+(explain|clarify|elaborate)',
]

# Pronouns that suggest a reference to previous context
CONTEXT_PRONOUNS = r'\b(it|that|this|these|those|they|them|its|their)\b'

def needs_reformulation(query: str, chat_history) -> bool:
    """
    Lightweight heuristic to decide if a question needs LLM reformulation.
    Returns True if the question likely references previous context.
    """
    # Option A: No chat history = first message, always standalone.
    # This is a guaranteed skip — the system-generated initial query
    # ("Greet me and ask me a question about the topic: X") is always
    # self-contained. Saves 2-8 seconds on every new conversation.
    if not chat_history:
        return False

    cleaned = query.strip().lower()

    # Short ambiguous phrases
    for pattern in AMBIGUOUS_PATTERNS:
        if re.match(pattern, cleaned, re.IGNORECASE):
            return True

    # Very short messages (< 4 words) are likely ambiguous
    word_count = len(cleaned.split())
    if word_count < 4:
        return True

    # Check for context-dependent pronouns
    # Only flag if pronouns appear AND the message is relatively short
    # (longer messages with pronouns are usually self-contained)
    if word_count < 15 and re.search(CONTEXT_PRONOUNS, cleaned):
        return True

    return False
```

Then in `get_vectorstore_retriever`, replace the unconditional `create_history_aware_retriever` with a conditional wrapper:

```python
def get_vectorstore_retriever(
    llm,
    vectorstore_config_dict,
    embeddings,
    allowed_file_ids=None,
    connection=None,
):
    # ... existing connection string setup ...

    def retrieve(query: str) -> List[Document]:
        query_embedding = embeddings.embed_query(query)
        return hybrid_search(
            query=query,
            query_embedding=query_embedding,
            connection_string=psycopg2_connection_string,
            collection_name=collection_name,
            allowed_file_ids=allowed_file_ids,
            connection=connection,
        )

    retriever = RunnableLambda(retrieve)

    # Build the LLM-based reformulation chain (used only when needed)
    contextualize_q_system_prompt = (
        "Given a chat history and the latest user question "
        "which might reference context in the chat history, "
        "formulate a standalone question which can be understood "
        "without the chat history. Do NOT answer the question, "
        "just reformulate it if needed and otherwise return it as is."
    )
    contextualize_q_prompt = ChatPromptTemplate.from_messages([
        ("system", contextualize_q_system_prompt),
        MessagesPlaceholder("chat_history"),
        ("human", "{input}"),
    ])
    history_aware_retriever = create_history_aware_retriever(
        llm, retriever, contextualize_q_prompt
    )

    # Return a wrapper that conditionally skips the LLM reformulation
    def conditional_retriever(input_dict):
        query = input_dict.get("input", "")
        chat_history = input_dict.get("chat_history", [])

        if needs_reformulation(query, chat_history):
            # Use the full LLM-based history-aware retriever
            return history_aware_retriever.invoke(input_dict)
        else:
            # Skip LLM call — use the raw query directly for retrieval
            return retriever.invoke(query)

    return RunnableLambda(conditional_retriever)
```

**Important integration note:** The return type changes. `create_history_aware_retriever` returns a Runnable that `create_retrieval_chain` expects. The conditional wrapper must return the same type (a list of Documents) for `create_retrieval_chain` to work. Both `history_aware_retriever.invoke()` and `retriever.invoke()` return `List[Document]`, so this is compatible.

However, `create_retrieval_chain` calls the retriever with a dict `{"input": ..., "chat_history": ...}`, not a plain string. The `history_aware_retriever` expects this dict. The plain `retriever` (RunnableLambda wrapping `retrieve()`) expects a string. The conditional wrapper handles this by extracting the query string for the direct path.

### Estimated Impact

| Scenario | Current | With Heuristic | Reason |
|----------|---------|---------------|--------|
| First message (no history) | LLM call #1: 2-8s | Skipped: 0s | Option A — guaranteed, no heuristic needed |
| Standalone question (most messages) | LLM call #1: 2-8s | Skipped: 0s | Heuristic detects no ambiguity |
| Ambiguous follow-up ("explain that") | LLM call #1: 2-8s | LLM call #1: 2-8s (unchanged) | Heuristic triggers reformulation |
| Typical message total time | 5-20s | 3-12s | |

The first-message skip (Option A) is the highest-value case because it's the student's first impression of the chatbot — the moment they're most sensitive to latency. It's also zero-risk since there's no chat history to reference.

### Risk Assessment

- **False negatives** (skipping reformulation when it was needed): The retriever searches with the raw question, which may return less relevant documents. But the response LLM (Call #2) still has the full chat history in its prompt via `MessagesPlaceholder("chat_history")`, so it can still produce a contextually appropriate answer. The impact is slightly less relevant document retrieval, not a broken response.
- **False positives** (reformulating when it wasn't needed): No harm — the LLM returns the question unchanged, same as current behavior. Just wastes 2-8 seconds, same as today.
- **Tuning**: The heuristic thresholds (word count < 4, word count < 15 with pronouns) can be adjusted based on real conversation data. Start conservative (skip less) and loosen over time.
- **Testability**: Log whether reformulation was skipped or used, and compare the reformulated query vs the original. If they're identical >80% of the time, the heuristic is working correctly.
- **Rollback**: Set an environment variable `ALWAYS_REFORMULATE=true` to disable the heuristic and revert to current behavior without a code deploy.

---

## ARCH-3: Remove Session Naming from Text Generation Critical Path

Saves 2-8 seconds on the student's first reply by not blocking the AI response on a cosmetic LLM call.

### The Problem

After the AI response is fully generated and ready to return, the text generation Lambda runs `update_session_name()` before sending the response back to the student:

```python
# In handler() — main.py

# AI response is READY at this point
response = get_response(...)

# But we don't return it yet — we block on session naming
potential_session_name = update_session_name(TABLE_NAME, session_id, effective_llm_model_id)

# NOW we finally return to the student
return { "statusCode": 200, "body": json.dumps({ "session_name": ..., "llm_output": ... }) }
```

On the student's first reply (the second exchange in the conversation), `update_session_name` does:
1. Creates a new `boto3.client("dynamodb")` — ~5ms
2. Reads the full chat history from DynamoDB — ~20-50ms
3. Determines this is the first exchange
4. Creates a new `ChatBedrock` or `BedrockLLM` instance — ~5ms
5. **Calls Bedrock to generate a ~30 character session title — 2-8 seconds**
6. Returns the title

The AI's actual answer is sitting in memory, ready to display, but the Lambda holds it for 2-8 seconds while it thinks of a name like "Photosynthesis Discussion."

On the 2nd+ reply, `update_session_name` reads DynamoDB, sees more than 2 messages, and returns `None` (~20-50ms). So this only hurts the first reply — but that's the moment the student is most engaged and most sensitive to latency.

### Why It's Redundant

The frontend already handles session naming independently. After receiving the text_gen response:

```javascript
// StudentChat.jsx — runs AFTER text_gen returns
.then((textGenData) => {
  // Updates the sidebar with the session name from the response
  setSession({ ...prevSession, session_name: textGenData.session_name });
  setSessions(prevSessions => prevSessions.map(s =>
    s.session_id === newSession.session_id
      ? { ...s, session_name: titleCase(textGenData.session_name) }
      : s
  ));

  // Then calls a SEPARATE API to persist the name
  return Promise.all([
    fetch(updateSessionNameUrl, { method: "PUT", body: JSON.stringify({ session_name: textGenData.session_name }) }),
    fetch(updateModuleScoreUrl, { method: "POST" }),
  ]);
})
```

The frontend takes the `session_name` from the text_gen response and:
1. Updates the UI sidebar
2. Calls `PUT /student/update_session_name` to persist it in the DB

So the text generation Lambda generates the name, returns it in the response, and then the frontend saves it via a separate API call. The Lambda is doing expensive work (a full Bedrock LLM call) for something the frontend is going to handle anyway.

### Recommended Change

Remove `update_session_name()` from the text generation Lambda entirely. Return the AI response immediately after `get_response()` finishes.

**In `main.py` handler, replace:**

```python
try:
    potential_session_name = update_session_name(TABLE_NAME, session_id, effective_llm_model_id)
    if potential_session_name:
        session_name = potential_session_name
except Exception as e:
    logger.error(f"Error updating session name: {e}")
    session_name = "New Chat"

return {
    "statusCode": 200,
    "body": json.dumps({
        "session_name": session_name,
        "llm_output": response.get("llm_output", ...),
        "llm_verdict": response.get("llm_verdict", ...),
    })
}
```

**With:**

```python
return {
    "statusCode": 200,
    "body": json.dumps({
        "session_name": session_name,  # stays "New Chat" from query params
        "llm_output": response.get("llm_output", ...),
        "llm_verdict": response.get("llm_verdict", ...),
    })
}
```

The session name stays as "New Chat" until the frontend renames it. For the rename, two options:

**Option 1a — Simple client-side naming (no LLM call):**

The frontend generates a name from the first few words of the student's message or the AI's response. No API call needed:

```javascript
// After receiving text_gen response for the first exchange
const autoName = textGenData.llm_output.split(/[.!?]/)[0].substring(0, 30);
// e.g., "Let's explore photosynthesis" → "Let's explore photosynthesis"
```

This is instant, free, and good enough for a sidebar label.

**Option 1b — Keep LLM naming but move it to `PUT /student/update_session_name`:**

The existing `PUT /student/update_session_name` endpoint in `studentFunction.js` currently just saves a name the frontend sends. It could be enhanced to generate the name server-side if the frontend sends a flag like `?generate=true`. This moves the LLM call to a non-blocking post-response flow — the student already has the AI response, and the sidebar updates a few seconds later when the name comes back.

**Recommended: Option 1a.** It's the simplest, eliminates a Bedrock LLM call entirely (saves cost too), and the student sees a meaningful session name instantly. If the LLM-generated names are strongly preferred, use Option 1b.

### What to Do with `update_session_name` in `chat.py`

The function can be deleted from `chat.py` since it's no longer called. Also remove its import from `main.py`:

```python
# Remove from import line:
from helpers.chat import get_bedrock_llm, get_initial_student_query, get_student_query, create_dynamodb_history_table, get_response  # removed: update_session_name
```

### Estimated Impact

| Scenario | Current | After Change |
|----------|---------|-------------|
| First student reply | AI response ready + 2-8s naming delay | AI response returned immediately |
| 2nd+ student reply | AI response ready + ~30ms DynamoDB check | AI response returned immediately |
| Session name appearance | Appears with AI response (delayed) | "New Chat" → auto-named instantly (Option 1a) |

### Risk Assessment

- **Breaking changes**: The `session_name` field in the text_gen response will always be "New Chat" instead of an LLM-generated name. The frontend already handles this — it uses `textGenData.session_name` to update the sidebar, and "New Chat" is the default. With Option 1a, the frontend generates a better name client-side.
- **Cost savings**: Eliminates one Bedrock LLM call on the first exchange of every conversation. At scale (1,000 students × 5 new conversations/week), that's 5,000 fewer Bedrock invocations per week.
- **Rollback**: If LLM-generated names are needed, the `update_session_name` function still exists in git history and can be restored. Or use Option 1b to move it to the post-response flow.

---

## ARCH-4: Cache `ChatBedrock` Instance Per Model ID

Saves ~10-15ms per invocation by avoiding redundant boto3 client creation and LangChain object construction on every request.

### The Problem

Every invocation of the handler calls `get_bedrock_llm(effective_llm_model_id)`, which creates a brand new `ChatBedrock` instance:

```python
# chat.py — called on EVERY request
def get_bedrock_llm(bedrock_llm_id, temperature=0):
    return ChatBedrock(
        model_id=bedrock_llm_id,
        model_kwargs=model_kwargs,
    )
```

`ChatBedrock` is constructed without a `client` parameter, so LangChain internally creates a new `boto3.client("bedrock-runtime")` each time. boto3 client creation involves loading the Bedrock service model JSON from disk and initializing the HTTP session — roughly 10-15ms.

Meanwhile, a perfectly good `bedrock_runtime` client already exists at module level in `main.py`:

```python
# main.py — created once at cold start, never reused by ChatBedrock
bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)
```

This client is used for `BedrockEmbeddings` but not passed to `ChatBedrock`. So every request creates a duplicate Bedrock client.

### Why It Can Be Cached

The `ChatBedrock` object only depends on two things:
- `model_id` — there are only 2 supported models (`meta.llama3-70b-instruct-v1:0` and `anthropic.claude-3-sonnet-20240229-v1:0`)
- `model_kwargs` — `temperature` is always 0, `max_tokens` is always 4000 for Claude

These don't change between requests. A Lambda container handling 100 requests for the same course uses the same model every time. Even across courses, there are only 2 possible model IDs.

The `ChatBedrock` instance is stateless — it doesn't hold conversation state, connection state, or any per-request data. It's just a configured wrapper around a boto3 client. Safe to reuse.

### Recommended Change

Cache `ChatBedrock` instances per model ID and pass the existing global `bedrock_runtime` client:

```python
# main.py — add to global cached resources
_llm_cache = {}

# chat.py — replace get_bedrock_llm
def get_bedrock_llm(bedrock_llm_id, temperature=0, client=None):
    cache_key = f"{bedrock_llm_id}:{temperature}"
    if cache_key not in _llm_cache:
        if "claude" in bedrock_llm_id.lower():
            model_kwargs = {
                "temperature": temperature,
                "max_tokens": 4000,
            }
        else:
            model_kwargs = {
                "temperature": temperature,
            }
        _llm_cache[cache_key] = ChatBedrock(
            model_id=bedrock_llm_id,
            model_kwargs=model_kwargs,
            client=client,  # reuse the global bedrock_runtime client
        )
    return _llm_cache[cache_key]
```

In the handler, pass the global client:

```python
llm = get_bedrock_llm(effective_llm_model_id, client=bedrock_runtime)
```

The cache lives in module-level global scope, so it persists across warm invocations for the lifetime of the Lambda container. With only 2 possible model IDs, the cache holds at most 2 entries.

### What This Eliminates Per Warm Invocation

| Object | Current | With Cache |
|--------|---------|-----------|
| `boto3.client("bedrock-runtime")` | Created every request (~10ms) | Reused from global |
| `ChatBedrock` wrapper | Created every request (~2-3ms) | Reused from cache |
| Service model JSON parse | Every request (~3-5ms) | Once per container |
| Total | ~15ms | ~0ms (cache hit) |

### Risk Assessment

- **Thread safety**: Lambda runs one request at a time per container. No concurrent access to the cache. No risk.
- **Staleness**: The model ID and kwargs are static configuration. They only change if an instructor changes the course's LLM model, which triggers a new request with a different `effective_llm_model_id` — that's a cache miss, so a new instance is created. No staleness risk.
- **Memory**: Two `ChatBedrock` instances in memory is negligible (~1-2KB each).
- **Impact**: ~15ms saved per request. Small compared to ARCH-1/2/3, but it's a free optimization with zero complexity. Worth doing alongside the other changes.

---

## Issue 5: Unbounded Chat History — No Action Needed

### Status: Deferred — not optimizing

### Analysis

`DynamoDBChatMessageHistory` loads the entire conversation history on every invocation and sends it to the LLM twice (once for the history-aware retriever, once for the RAG response). As conversations grow, this increases DynamoDB read size, LLM input token count, LLM latency, and Bedrock cost.

However, after investigation this is intentional and correct for this application. The full chat history provides the LLM with the pedagogical context it needs to guide the student toward understanding the course material — what topics have been covered, what the student struggled with, what questions have already been asked. Truncating the history would degrade the LLM's ability to fulfill its role as an instructor.

### Why it's not a problem in practice

- The system prompt instructs the LLM to complete the conversation after "at least 5 interactions and 300 words." Typical conversations are 10-20 messages.
- A 20-message conversation is roughly 3,000-5,000 tokens of history — well within Llama 3 70B's 8K context window and trivial for Claude 3 Sonnet's 200K window.
- The latency impact of this history size (~1-2 seconds of extra LLM processing) is small relative to the base LLM inference time.

### When to revisit

- If conversations regularly exceed 30+ messages (monitor via DynamoDB item sizes)
- If LLM latency on later messages becomes noticeably worse than early messages
- If the application switches to a model with a smaller context window

### Future option if needed

Async progressive summarization: keep the last N messages in full, fold older messages into a running summary that's updated after each response is returned (not before — so the student never waits for it). The summary preserves the pedagogical state ("student struggled with X, understood Y") while bounding token count. This adds implementation complexity and is not justified at current conversation lengths.
