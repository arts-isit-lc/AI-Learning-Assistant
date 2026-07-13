import { useEffect, useRef, useState } from "react";
import apiClient from "../../services/api";
import { titleCase } from "../../utils/formatters";

// Backstop for the authoritative stream terminator. If the terminal (done)
// message never arrives (Lambda died / network dropped), surface the retry
// banner instead of hanging. Set above the chatbot Lambda's 120s timeout.
const WATCHDOG_MS = 130000;

/**
 * Custom hook for chat session state and handlers.
 * Manages: sessions, messages, streaming (WebSocket), submit, retry, new chat, delete.
 *
 * Delivery model (Option B): the AppSync WebSocket stream is AUTHORITATIVE. The
 * `POST student/chatbot-v2` is a fire-and-forget trigger — on a slow (multi-image)
 * turn it times out at API Gateway's 29s cap while the Lambda keeps running and
 * streams the answer + render blocks. `finalizeTurn` renders the final message
 * from the terminal stream message (or from the POST JSON when it returns fast /
 * the WebSocket is unavailable — it is idempotent so whichever arrives first wins).
 */
export default function useChatSession(course, module) {
  const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [newMessage, setNewMessage] = useState(null);
  const [isAItyping, setIsAItyping] = useState(false);
  const [loading, setLoading] = useState(true);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [retryError, setRetryError] = useState(null);
  const [historyError, setHistoryError] = useState(false);
  const wsRef = useRef(null);
  const watchdogRef = useRef(null);
  const accumulatedTextRef = useRef("");
  const turnCtxRef = useRef(null);
  const finalizedRef = useRef(false);
  const textareaRef = useRef(null);
  // When true, the next session-identity change skips the history refetch. Set
  // when we create a brand-new chat (it has no persisted history yet, and its
  // streamed greeting must not be clobbered by an empty DB read).
  const skipHistoryFetchRef = useRef(false);

  // --- Stream-authoritative turn completion ---

  // AWSJSON blocks arrive over the subscription as a JSON string; the POST
  // fallback delivers them as an array. Accept either (and guard double-encoding).
  const parseBlocks = (blocks) => {
    if (!blocks) return null;
    try {
      let parsed = typeof blocks === "string" ? JSON.parse(blocks) : blocks;
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      console.error("Failed to parse message blocks:", e);
      return null;
    }
  };

  // Finalize a turn from the authoritative terminal payload (stream done=true, or
  // the POST JSON as a fast-path fallback, or a watchdog error). Idempotent:
  // whichever channel arrives first wins; later calls are ignored.
  const finalizeTurn = (payload) => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;

    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    setIsStreaming(false);
    setIsAItyping(false);
    setIsSubmitting(false);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const ctx = turnCtxRef.current || {};

    if (!payload || payload.error) {
      setRetryError({
        sessionId: ctx.sessionId,
        sessionName: ctx.sessionName,
        messageContent: ctx.messageContent ?? null,
        source: ctx.source || "submit",
      });
      return;
    }

    const finalText = payload.llm_output ?? accumulatedTextRef.current ?? "";
    const parsedBlocks = parseBlocks(payload.blocks);
    const streamedName = payload.session_name;
    const autoName =
      streamedName && streamedName !== "New Chat" && streamedName !== "New chat"
        ? streamedName
        : finalText.split(/[.!?]/)[0].substring(0, 30) || "New Chat";

    setSession((prev) => (prev ? { ...prev, session_name: autoName } : prev));
    setSessions((prev) =>
      prev.map((s) =>
        s.session_id === ctx.sessionId ? { ...s, session_name: titleCase(autoName) } : s
      )
    );

    setNewMessage({
      message_id: `ai-${Date.now()}`,
      message_content: finalText,
      blocks: parsedBlocks,
      student_sent: false,
      session_id: ctx.sessionId,
      time_sent: new Date().toISOString(),
    });

    // Best-effort side effects — never block rendering.
    apiClient
      .putRaw("student/update_session_name", { session_id: ctx.sessionId }, { session_name: autoName })
      .catch(() => null);
    if (ctx.email) {
      apiClient
        .postRaw("student/update_module_score", {
          module_id: ctx.moduleId,
          student_email: ctx.email,
          course_id: ctx.courseId,
          llm_verdict: payload.llm_verdict,
        })
        .catch(() => null);
    }
  };

  // --- WebSocket streaming ---

  const subscribeToChunks = (turnCtx) => {
    turnCtxRef.current = turnCtx;
    accumulatedTextRef.current = "";
    finalizedRef.current = false;
    const sessionId = turnCtx.sessionId;
    try {
      const tempUrl = import.meta.env.VITE_GRAPHQL_WS_URL;
      if (!tempUrl) return;

      const apiUrl = tempUrl.replace("https://", "wss://");
      const urlObj = new URL(apiUrl);
      const tmpObj = new URL(tempUrl);
      urlObj.hostname = urlObj.hostname.replace("appsync-api", "appsync-realtime-api");

      const header = {
        host: tmpObj.hostname,
        Authorization: `API_KEY=${import.meta.env.VITE_API_KEY}`,
      };
      const encodedHeader = btoa(JSON.stringify(header));
      const wsUrl = `${urlObj.toString()}?header=${encodedHeader}&payload=e30=`;

      const ws = new WebSocket(wsUrl, "graphql-ws");
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "connection_init" }));
        const subscriptionMessage = {
          id: sessionId,
          type: "start",
          payload: {
            data: JSON.stringify({
              query: `subscription OnChatChunk($session_id: String!) { onChatChunk(session_id: $session_id) { session_id chunk done llm_output blocks session_name llm_verdict error } }`,
              variables: { session_id: sessionId },
            }),
            extensions: {
              authorization: {
                Authorization: `API_KEY=${import.meta.env.VITE_API_KEY}`,
                host: tmpObj.hostname,
              },
            },
          },
        };
        ws.send(JSON.stringify(subscriptionMessage));
        setIsStreaming(true);
        setStreamingText("");
        if (watchdogRef.current) clearTimeout(watchdogRef.current);
        watchdogRef.current = setTimeout(() => finalizeTurn({ error: true }), WATCHDOG_MS);
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "data" && message.payload?.data?.onChatChunk) {
          const c = message.payload.data.onChatChunk;
          if (c.done) {
            // Terminal message: authoritative final payload (or error flag).
            finalizeTurn(c);
          } else if (c.chunk) {
            accumulatedTextRef.current += c.chunk;
            setStreamingText((prev) => prev + c.chunk);
          }
        }
      };

      ws.onerror = () => {
        setIsStreaming(false);
        if (ws) ws.close();
        wsRef.current = null;
      };

      ws.onclose = () => {
        wsRef.current = null;
      };
    } catch (e) {
      console.error("Failed to subscribe to chat chunks:", e);
    }
  };

  // Clean up WebSocket + watchdog on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
      }
    };
  }, []);

  // --- Session/message loading ---

  useEffect(() => {
    if (
      !loading &&
      !creatingSession &&
      !isSubmitting &&
      !isAItyping &&
      sessions.length === 0
    ) {
      handleNewChat();
    }
  }, [sessions, creatingSession]);

  useEffect(() => {
    if (newMessage !== null) {
      if (currentSessionId === session?.session_id) {
        setStreamingText("");
        setIsStreaming(false);
        setMessages((prevItems) => [...prevItems, newMessage]);
      }
      setNewMessage(null);
    }
  }, [session, newMessage, currentSessionId]);

  useEffect(() => {
    const fetchModule = async () => {
      setLoading(true);
      if (!course || !module) return;

      try {
        const { email } = await apiClient.getAuth();
        const data = await apiClient.get("student/module", {
          email,
          course_id: course.course_id,
          module_id: module.module_id,
        });
        setSessions(data);
        setSession(data[data.length - 1]);
      } catch (error) {
        console.error("Error fetching module:", error.message);
      } finally {
        setLoading(false);
      }
    };

    fetchModule();
  }, [course, module]);

  // Load persisted history only when the SESSION IDENTITY changes — i.e. the
  // user switches sessions or the module loads its initial session. Keying on
  // the whole `session` object used to re-fire this whenever finalizeTurn
  // spread a new object to auto-rename the session (same session_id), firing a
  // full-history REST refetch mid-turn that replaced the freshly streamed
  // answer with stale/empty DB data (or [] on fetch error) — blanking the chat
  // while a response was returning.
  useEffect(() => {
    if (!session?.session_id) return;
    if (skipHistoryFetchRef.current) {
      skipHistoryFetchRef.current = false;
      return;
    }
    getMessages();
  }, [session?.session_id]);

  const getMessages = async () => {
    setHistoryError(false);
    try {
      const data = await apiClient.get("student/get_messages", {
        session_id: session.session_id,
      });
      // message_blocks (JSONB) is persisted with each AI message, so figures/
      // tables/formulas reconstruct directly from the DB on history reload.
      setMessages(
        data.map((msg) => ({
          ...msg,
          blocks: msg.message_blocks || undefined,
        }))
      );
    } catch (error) {
      // Don't blank the thread on a failed history load — keep whatever is
      // already rendered and surface an inline, retryable error instead.
      console.error("Error fetching session:", error.message);
      setHistoryError(true);
    }
  };

  // Retry a failed history load for the current session (inline "Retry" button).
  const handleReloadHistory = () => {
    if (session?.session_id) getMessages();
  };

  // --- Handlers ---

  const handleSubmit = () => {
    if (isSubmitting || isAItyping || creatingSession) return;
    setIsSubmitting(true);
    let newSession;
    const messageContent = textareaRef.current.value.trim();
    let getSession;

    if (!messageContent) {
      setIsSubmitting(false);
      return;
    }
    if (session) {
      getSession = Promise.resolve(session);
    } else {
      if (!creatingSession) {
        setCreatingSession(true);
        handleNewChat();
      }
      setIsSubmitting(false);
      return;
    }

    getSession
      .then((retrievedSession) => {
        newSession = retrievedSession;
        setCurrentSessionId(newSession.session_id);
        return apiClient.getAuth();
      })
      .then(({ email }) => {
        setNewMessage({
          message_id: `opt-${Date.now()}`,
          message_content: messageContent,
          student_sent: true,
          session_id: newSession.session_id,
          time_sent: new Date().toISOString(),
        });
        setIsAItyping(true);
        textareaRef.current.value = "";

        // Stream is authoritative (finalizeTurn). The POST is a fire-and-forget
        // trigger: it may 504 at API Gateway's 29s cap on a slow multi-image
        // turn while the Lambda keeps running and streams the result. We still
        // finalize from its JSON when it returns fast (fallback if WS is down).
        subscribeToChunks({
          sessionId: newSession.session_id,
          sessionName: newSession.session_name,
          messageContent,
          source: "submit",
          email,
          courseId: course.course_id,
          moduleId: module.module_id,
        });

        apiClient
          .postRaw(
            "student/chatbot-v2",
            { course_id: course.course_id, session_id: newSession.session_id, module_id: module.module_id, session_name: newSession.session_name },
            { message_content: messageContent }
          )
          .then((resp) => (resp.ok ? resp.json() : null))
          .then((data) => {
            if (data) finalizeTurn(data);
          })
          .catch(() => null);
      })
      .catch((error) => {
        // Pre-turn failure (auth/session). Turn-level failures arrive via the
        // stream (finalizeTurn with error) or the watchdog.
        setIsSubmitting(false);
        setIsAItyping(false);
        setRetryError({
          sessionId: newSession?.session_id,
          sessionName: newSession?.session_name,
          messageContent,
          source: "submit",
        });
        console.error("Error:", error);
      });
  };

  const handleRetry = () => {
    if (!retryError) return;
    const { sessionId, sessionName, messageContent, source } = retryError;
    setRetryError(null);
    setIsAItyping(true);

    apiClient
      .getAuth()
      .then(({ email }) => {
        subscribeToChunks({
          sessionId,
          sessionName,
          messageContent,
          source,
          email,
          courseId: course.course_id,
          moduleId: module.module_id,
        });

        apiClient
          .postRaw(
            "student/chatbot-v2",
            { course_id: course.course_id, session_id: sessionId, module_id: module.module_id, session_name: sessionName },
            messageContent ? { message_content: messageContent } : undefined
          )
          .then((resp) => (resp.ok ? resp.json() : null))
          .then((data) => {
            if (data) finalizeTurn(data);
          })
          .catch(() => null);
      })
      .catch((error) => {
        console.error("Retry failed:", error);
        setIsAItyping(false);
        setRetryError({ sessionId, sessionName, messageContent, source });
      });
  };

  const handleNewChat = () => {
    let sessionData;
    let userEmail;
    setIsAItyping(true);
    return apiClient.getAuth()
      .then(({ email }) => {
        userEmail = email;
        return apiClient.postRaw("student/create_session", {
          email,
          course_id: course.course_id,
          module_id: module.module_id,
          session_name: "New chat",
        });
      })
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to create session: ${response.statusText}`);
        return response.json();
      })
      .then((data) => {
        sessionData = data[0];
        setCurrentSessionId(sessionData.session_id);
        setSessions((prevItems) => [...prevItems, sessionData]);
        // A brand-new session has no persisted history: clear the thread now and
        // skip the auto history-refetch so the streamed greeting isn't clobbered
        // by an empty DB read racing the optimistic append.
        setMessages([]);
        skipHistoryFetchRef.current = true;
        setSession(sessionData);
        setCreatingSession(false);

        // Greeting is delivered over the stream (finalizeTurn); the POST is a
        // fire-and-forget trigger.
        subscribeToChunks({
          sessionId: sessionData.session_id,
          sessionName: "New chat",
          messageContent: null,
          source: "newChat",
          email: userEmail,
          courseId: course.course_id,
          moduleId: module.module_id,
        });

        apiClient
          .postRaw(
            "student/chatbot-v2",
            { course_id: course.course_id, session_id: sessionData.session_id, module_id: module.module_id, session_name: "New chat" }
          )
          .then((resp) => (resp.ok ? resp.json() : null))
          .then((textData) => {
            if (textData) finalizeTurn(textData);
          })
          .catch(() => null);

        return sessionData;
      })
      .catch((error) => {
        console.error("Error creating new chat:", error);
        setCreatingSession(false);
        setIsAItyping(false);
        if (sessionData) {
          setRetryError({ sessionId: sessionData.session_id, sessionName: "New chat", messageContent: null, source: "newChat" });
        }
      });
  };

  const handleDeleteSession = async (sessionDelete) => {
    try {
      const { email } = await apiClient.getAuth();
      await apiClient.delete("student/delete_session", {
        email,
        course_id: course.course_id,
        module_id: module.module_id,
        session_id: sessionDelete.session_id,
      });
      setSessions((prevSessions) =>
        prevSessions.filter((s) => s.session_id !== sessionDelete.session_id)
      );
      if (sessionDelete.session_id === session?.session_id) {
        setSession(null);
        setMessages([]);
      }
    } catch (error) {
      console.error("Error deleting session:", error.message);
    }
  };

  const handleDeleteMessage = async () => {
    try {
      await apiClient.delete("student/delete_last_message", {
        session_id: session.session_id,
      });
      setMessages((prevMessages) => {
        if (prevMessages.length >= 2) return prevMessages.slice(0, -2);
        return [];
      });
    } catch (error) {
      console.error("Error deleting message:", error.message);
    }
  };

  // --- Helpers ---

  const getMostRecentStudentMessageIndex = () => {
    const studentMessages = messages
      .map((message, index) => ({ ...message, index }))
      .filter((message) => message.student_sent);
    return studentMessages.length > 0
      ? studentMessages[studentMessages.length - 1].index
      : -1;
  };

  const hasAiMessageAfter = (recentStudentMessageIndex) => {
    return messages
      .slice(recentStudentMessageIndex + 1)
      .some((message) => !message.student_sent);
  };

  return {
    textareaRef,
    sessions,
    session,
    setSession,
    setSessions,
    messages,
    setMessages,
    isSubmitting,
    isAItyping,
    creatingSession,
    setCreatingSession,
    loading,
    streamingText,
    isStreaming,
    retryError,
    historyError,
    currentSessionId,
    handleSubmit,
    handleRetry,
    handleReloadHistory,
    handleNewChat,
    handleDeleteSession,
    handleDeleteMessage,
    getMostRecentStudentMessageIndex,
    hasAiMessageAfter,
  };
}
