import { useEffect, useRef, useState } from "react";
import apiClient from "../../services/api";
import { titleCase } from "../../utils/formatters";

/**
 * Custom hook for chat session state and handlers.
 * Manages: sessions, messages, streaming (WebSocket), submit, retry, new chat, delete.
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
  const wsRef = useRef(null);
  const textareaRef = useRef(null);

  // --- WebSocket streaming ---

  const subscribeToChunks = (sessionId) => {
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
              query: `subscription OnChatChunk($session_id: String!) { onChatChunk(session_id: $session_id) { session_id chunk done } }`,
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
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "data" && message.payload?.data?.onChatChunk) {
          const { chunk, done } = message.payload.data.onChatChunk;
          if (done) {
            setIsStreaming(false);
            ws.close();
            wsRef.current = null;
          } else if (chunk) {
            setStreamingText((prev) => prev + chunk);
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

  // Clean up WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
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

  useEffect(() => {
    if (session) {
      getMessages();
    }
  }, [session]);

  const getMessages = async () => {
    try {
      const data = await apiClient.get("student/get_messages", {
        session_id: session.session_id,
      });
      setMessages((prevMessages) => {
        const blocksMap = new Map();
        prevMessages.forEach((msg) => {
          if (msg.blocks && msg.message_content) {
            blocksMap.set(msg.message_content, msg.blocks);
          }
        });
        if (blocksMap.size === 0) return data;
        return data.map((msg) => ({
          ...msg,
          blocks: msg.blocks || blocksMap.get(msg.message_content) || undefined,
        }));
      });
    } catch (error) {
      console.error("Error fetching session:", error.message);
      setMessages([]);
    }
  };

  // --- Handlers ---

  const handleSubmit = () => {
    if (isSubmitting || isAItyping || creatingSession) return;
    setIsSubmitting(true);
    let newSession;
    let userEmail;
    let messageContent = textareaRef.current.value.trim();
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
        userEmail = email;

        setNewMessage({
          message_id: `opt-${Date.now()}`,
          message_content: messageContent,
          student_sent: true,
          session_id: newSession.session_id,
          time_sent: new Date().toISOString(),
        });
        setIsAItyping(true);
        textareaRef.current.value = "";

        subscribeToChunks(newSession.session_id);

        return apiClient.postRaw(
          "student/chatbot-v2",
          { course_id: course.course_id, session_id: newSession.session_id, module_id: module.module_id, session_name: newSession.session_name },
          { message_content: messageContent }
        );
      })
      .then((textGenResponse) => {
        if (!textGenResponse.ok) {
          throw new Error(`Failed to generate text: ${textGenResponse.statusText}`);
        }
        return textGenResponse.json();
      })
      .then((textGenData) => {
        const autoName = textGenData.session_name !== "New Chat"
          ? textGenData.session_name
          : textGenData.llm_output.split(/[.!?]/)[0].substring(0, 30) || "New Chat";

        setSession((prevSession) => ({ ...prevSession, session_name: autoName }));
        setSessions((prevSessions) =>
          prevSessions.map((s) =>
            s.session_id === newSession.session_id
              ? { ...s, session_name: titleCase(autoName) }
              : s
          )
        );

        setNewMessage({
          message_id: `ai-${Date.now()}`,
          message_content: textGenData.llm_output,
          blocks: textGenData.blocks || null,
          student_sent: false,
          session_id: newSession.session_id,
          time_sent: new Date().toISOString(),
        });

        return Promise.all([
          apiClient.putRaw(
            "student/update_session_name",
            { session_id: newSession.session_id },
            { session_name: autoName }
          ),
          apiClient.postRaw(
            "student/update_module_score",
            { module_id: module.module_id, student_email: userEmail, course_id: course.course_id, llm_verdict: textGenData.llm_verdict }
          ),
        ]);
      })
      .then(([response1, response2]) => {
        if (!response1.ok || !response2.ok) {
          console.error("Failed to update session name or module score");
        }
      })
      .catch((error) => {
        setIsSubmitting(false);
        setIsAItyping(false);
        setRetryError({
          sessionId: newSession?.session_id,
          sessionName: newSession?.session_name,
          messageContent,
          source: "submit",
        });
        console.error("Error:", error);
      })
      .finally(() => {
        setIsSubmitting(false);
        setIsAItyping(false);
      });
  };

  const handleRetry = () => {
    if (!retryError) return;
    const { sessionId, sessionName, messageContent, source } = retryError;
    setRetryError(null);
    setIsAItyping(true);

    subscribeToChunks(sessionId);

    const textGenPromise = apiClient.postRaw(
      "student/chatbot-v2",
      { course_id: course.course_id, session_id: sessionId, module_id: module.module_id, session_name: sessionName },
      messageContent ? { message_content: messageContent } : undefined
    );

    textGenPromise
      .then((textGenResponse) => {
        if (!textGenResponse.ok) {
          throw new Error(`Failed to generate text: ${textGenResponse.statusText}`);
        }
        return textGenResponse.json();
      })
      .then(async (textGenData) => {
        const autoName = textGenData.session_name !== "New Chat"
          ? textGenData.session_name
          : textGenData.llm_output.split(/[.!?]/)[0].substring(0, 30) || "New Chat";

        setSession((prevSession) => ({ ...prevSession, session_name: autoName }));
        setSessions((prevSessions) =>
          prevSessions.map((s) =>
            s.session_id === sessionId
              ? { ...s, session_name: titleCase(autoName) }
              : s
          )
        );

        setNewMessage({
          message_id: `ai-retry-${Date.now()}`,
          message_content: textGenData.llm_output,
          blocks: textGenData.blocks || null,
          student_sent: false,
          session_id: sessionId,
          time_sent: new Date().toISOString(),
        });

        const { email } = await apiClient.getAuth();
        await Promise.all([
          apiClient.putRaw("student/update_session_name", { session_id: sessionId }, { session_name: autoName }),
          apiClient.postRaw("student/update_module_score", { module_id: module.module_id, student_email: email, course_id: course.course_id, llm_verdict: textGenData.llm_verdict }),
        ]);
      })
      .catch((error) => {
        console.error("Retry failed:", error);
        setRetryError({ sessionId, sessionName, messageContent, source });
      })
      .finally(() => {
        setIsAItyping(false);
        setIsSubmitting(false);
      });
  };

  const handleNewChat = () => {
    let sessionData;
    setIsAItyping(true);
    return apiClient.getAuth()
      .then(({ email }) => {
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
        setSession(sessionData);
        setCreatingSession(false);

        subscribeToChunks(sessionData.session_id);

        return apiClient.postRaw(
          "student/chatbot-v2",
          { course_id: course.course_id, session_id: sessionData.session_id, module_id: module.module_id, session_name: "New chat" }
        );
      })
      .then((textResponse) => {
        if (!textResponse.ok) throw new Error(`Failed to create initial message: ${textResponse.statusText}`);
        return textResponse.json();
      })
      .then((textResponseData) => {
        setNewMessage({
          message_id: `ai-greet-${Date.now()}`,
          message_content: textResponseData.llm_output,
          blocks: textResponseData.blocks || null,
          student_sent: false,
          session_id: sessionData.session_id,
          time_sent: new Date().toISOString(),
        });
        return sessionData;
      })
      .catch((error) => {
        console.error("Error creating new chat:", error);
        setCreatingSession(false);
        setIsAItyping(false);
        if (sessionData) {
          setRetryError({ sessionId: sessionData.session_id, sessionName: "New chat", messageContent: null, source: "newChat" });
        }
      })
      .finally(() => {
        setIsAItyping(false);
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
    currentSessionId,
    handleSubmit,
    handleRetry,
    handleNewChat,
    handleDeleteSession,
    handleDeleteMessage,
    getMostRecentStudentMessageIndex,
    hasAiMessageAfter,
  };
}
