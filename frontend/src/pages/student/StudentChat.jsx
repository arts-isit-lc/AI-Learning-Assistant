import { useEffect, useRef, useState } from "react";
import AIMessage from "../../components/AIMessage";
import Session from "../../components/Session";
import StudentMessage from "../../components/StudentMessage";
import apiClient from "../../services/api";
import { useNavigate } from "react-router-dom";
import { signOut } from "aws-amplify/auth";
import ArrowCircleLeftRoundedIcon from "@mui/icons-material/ArrowCircleLeftRounded";
import { titleCase } from "../../utils/formatters";
import { handleSignOut } from "../../utils/auth";

const TypingIndicator = () => (
  <div className="flex items-center ml-28 mb-4">
    <div className="flex space-x-1">
      <div
        className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"
        style={{ animationDelay: "0s" }}
      ></div>
      <div
        className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"
        style={{ animationDelay: "0.2s" }}
      ></div>
      <div
        className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"
        style={{ animationDelay: "0.4s" }}
      ></div>
    </div>
    <span className="ml-2 text-gray-500">AI is typing...</span>
  </div>
);

const StudentChat = ({ course, module, setModule, setCourse }) => {
  const textareaRef = useRef(null);
  const messagesEndRef = useRef(null);
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
  const wsRef = useRef(null);
  const navigate = useNavigate();

  // ARCH-1: Subscribe to AppSync WebSocket for streaming chat chunks
  const subscribeToChunks = (sessionId) => {
    try {
      const tempUrl = import.meta.env.VITE_GRAPHQL_WS_URL;
      if (!tempUrl) return;

      // Build the realtime URL using the same pattern as InstructorHomepage
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
      // Non-blocking — if WebSocket fails, the text_gen API call still works
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
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  useEffect(() => {
    if (newMessage !== null) {
      if (currentSessionId === session.session_id) {
        // Clear streaming state only when the persisted message is ready,
        // so there's no gap between the streaming text disappearing and
        // the final message appearing (prevents the "double flash").
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
      if (!course || !module) {
        return;
      }

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

  const getMostRecentStudentMessageIndex = () => {
    const studentMessages = messages
      .map((message, index) => ({ ...message, index }))
      .filter((message) => message.student_sent);
    return studentMessages.length > 0
      ? studentMessages[studentMessages.length - 1].index
      : -1;
  };

  const hasAiMessageAfter = (messages, recentStudentMessageIndex) => {
    return messages
      .slice(recentStudentMessageIndex + 1)
      .some((message) => !message.student_sent);
  };

  async function retrieveKnowledgeBase(message, sessionId) {
    try {
      const { email } = await apiClient.getAuth();
      try {
        const data = await apiClient.post(
          "student/create_ai_message",
          { session_id: sessionId, email, course_id: course.course_id, module_id: module.module_id },
          { message_content: message }
        );
        setNewMessage(data[0]);
      } catch (error) {
        console.error("Error retreiving message:", error.message);
      }
    } catch (error) {
      console.error("Error retrieving message from knowledge base:", error.message);
    }
  }

  const handleSubmit = () => {
    if (isSubmitting || isAItyping || creatingSession) return;
    setIsSubmitting(true);
    let newSession;
    let userEmail;
    let messageContent = textareaRef.current.value.trim();
    let getSession;

    if (!messageContent) {
      console.warn("Message content is empty or contains only spaces.");
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

        // P-7: Show message optimistically and fire both calls in parallel
        setNewMessage({
          message_content: messageContent,
          student_sent: true,
          session_id: newSession.session_id,
          time_sent: new Date().toISOString(),
        });
        setIsAItyping(true);
        textareaRef.current.value = "";

        // ARCH-1: Subscribe to streaming chunks before firing text_gen
        subscribeToChunks(newSession.session_id);

        const createMessagePromise = apiClient.postRaw(
          "student/create_message",
          { session_id: newSession.session_id, email: userEmail, course_id: course.course_id, module_id: module.module_id },
          { message_content: messageContent }
        );

        const textGenPromise = apiClient.postRaw(
          "student/text_generation",
          { course_id: course.course_id, session_id: newSession.session_id, module_id: module.module_id, session_name: newSession.session_name },
          { message_content: messageContent }
        );

        return Promise.all([createMessagePromise, textGenPromise]);
      })
      .then(([createMsgResponse, textGenResponse]) => {
        if (!createMsgResponse.ok) {
          console.error("Failed to persist message, but continuing with AI response");
        }
        if (!textGenResponse.ok) {
          throw new Error(
            `Failed to generate text: ${textGenResponse.statusText}`
          );
        }
        return textGenResponse.json();
      })
      .then((textGenData) => {
        // ARCH-1: Streaming state is now cleared in the newMessage useEffect
        // to avoid a visual gap between streaming text and the persisted message.

        // ARCH-3: Generate session name client-side from AI response (Option 1a)
        const autoName = textGenData.session_name !== "New Chat"
          ? textGenData.session_name
          : textGenData.llm_output.split(/[.!?]/)[0].substring(0, 30) || "New Chat";

        setSession((prevSession) => ({
          ...prevSession,
          session_name: autoName,
        }));

        setSessions((prevSessions) => {
          return prevSessions.map((s) =>
            s.session_id === newSession.session_id
              ? { ...s, session_name: titleCase(autoName) }
              : s
          );
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
          textGenData,
        ]);
      })
      .then(([response1, response2, textGenData]) => {
        if (!response1.ok || !response2.ok) {
          throw new Error("Failed to fetch endpoints");
        }

        return retrieveKnowledgeBase(
          textGenData.llm_output,
          newSession.session_id
        );
      })
      .catch((error) => {
        setIsSubmitting(false);
        setIsAItyping(false);
        console.error("Error:", error);
      })
      .finally(() => {
        setIsSubmitting(false);
        setIsAItyping(false);
      });
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const handleBack = () => {
    sessionStorage.removeItem("module");
    navigate(-1);
  };

  const handleNewChat = () => {
    let sessionData;
    let userEmail;
    setIsAItyping(true);
    return apiClient.getAuth()
      .then(({ email }) => {
        userEmail = email;
        const session_name = "New chat";

        return apiClient.postRaw("student/create_session", {
          email: userEmail,
          course_id: course.course_id,
          module_id: module.module_id,
          session_name,
        });
      })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to create session: ${response.statusText}`);
        }
        return response.json();
      })
      .then((data) => {
        sessionData = data[0];
        setCurrentSessionId(sessionData.session_id);
        setSessions((prevItems) => [...prevItems, sessionData]);
        setSession(sessionData);
        setCreatingSession(false);

        // ARCH-1: Subscribe to streaming chunks before firing text_gen
        subscribeToChunks(sessionData.session_id);

        return apiClient.postRaw(
          "student/text_generation",
          { course_id: course.course_id, session_id: sessionData.session_id, module_id: module.module_id, session_name: "New chat" }
        );
      })
      .then((textResponse) => {
        if (!textResponse.ok) {
          throw new Error(
            `Failed to create initial message: ${textResponse.statusText}`
          );
        }
        return textResponse.json();
      })
      .then((textResponseData) => {
        retrieveKnowledgeBase(
          textResponseData.llm_output,
          sessionData.session_id
        );
        return sessionData;
      })
      .catch((error) => {
        console.error("Error creating new chat:", error);
        setCreatingSession(false);
        setIsAItyping(false);
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
        prevSessions.filter(
          (isession) => isession.session_id !== sessionDelete.session_id
        )
      );
      if (sessionDelete.session_id === session.session_id) {
        setSession(null);
        setMessages([]);
      }
    } catch (error) {
      console.error("Error creating session:", error.message);
    }
  };

  const handleDeleteMessage = async (message) => {
    try {
      await apiClient.delete("student/delete_last_message", {
        session_id: session.session_id,
      });
      setMessages((prevMessages) => {
        if (prevMessages.length >= 2) {
          return prevMessages.slice(0, -2);
        } else {
          return [];
        }
      });
    } catch (error) {
      console.error("Error deleting message:", error.message);
    }
  };
  useEffect(() => {
    const handleResize = () => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;

        // Enforce max-height and add scroll when needed
        if (textarea.scrollHeight > parseInt(textarea.style.maxHeight)) {
          textarea.style.overflowY = "auto";
        } else {
          textarea.style.overflowY = "hidden";
        }
      }
    };

    handleResize();
    const textarea = textareaRef.current;

    if (textarea) {
      textarea.addEventListener("input", handleResize);

      textarea.addEventListener("keydown", handleKeyDown);
    }

    // Cleanup event listener on unmount
    return () => {
      if (textarea) {
        textarea.removeEventListener("input", handleResize);
        textarea.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [textareaRef.currrent, handleKeyDown]);
  useEffect(() => {
    const storedModule = sessionStorage.getItem("module");
    if (storedModule) {
      setModule(JSON.parse(storedModule));
    }
  }, [setModule]);

  useEffect(() => {
    const storedCourse = sessionStorage.getItem("course");
    if (storedCourse) {
      setCourse(JSON.parse(storedCourse));
    }
  }, [setCourse]);

  const getMessages = async () => {
    try {
      const data = await apiClient.get("student/get_messages", {
        session_id: session.session_id,
      });
      setMessages(data);
    } catch (error) {
      console.error("Error fetching session:", error.message);
      setMessages([]);
    }
  };
  useEffect(() => {
    if (session) {
      getMessages();
    }
  }, [session]);

  if (!module) {
    return <div>Loading...</div>;
  }

  return (
    <div className="flex flex-row h-screen">
      <div className="flex flex-col w-1/4 bg-gradient-to-tr from-purple-300 to-cyan-100">
        <div className="flex flex-row mt-3 mb-3 ml-4">
          <ArrowCircleLeftRoundedIcon
            onClick={() => handleBack()}
            className="cursor-pointer"
            sx={{ width: 32, height: 32 }}
          />
          <div className="ml-3 pt-0.5 text-black font-roboto font-bold text-lg">
            {titleCase(module.module_name)}
          </div>
        </div>
        <button
          onClick={() => {
            if (!creatingSession) {
              setCreatingSession(true);
              handleNewChat();
            }
          }}
          className="border border-black ml-8 mr-8 mt-0 mb-0 bg-transparent pt-1.5 pb-1.5"
        >
          <div className="flex flex-row gap-6">
            <div className="text-md font-roboto text-[#212427]">+</div>
            <div className="text-md font-roboto font-bold text-[#212427]">
              New Chat
            </div>
          </div>
        </button>
        <div className="my-4">
          <hr className="border-t border-black" />
        </div>
        <div className="font-roboto font-bold ml-8 text-start text-[#212427]">
          History
        </div>
        <div className=" overflow-y-auto mt-2 mb-6">
          {sessions
            .slice()
            .reverse()
            .map((iSession, index) => (
              <Session
                key={iSession.session_id}
                text={iSession.session_name}
                session={iSession}
                setSession={setSession}
                deleteSession={handleDeleteSession}
                selectedSession={session}
                setMessages={setMessages}
                setSessions={setSessions}
                sessions={sessions}
              />
            ))}
        </div>
      </div>
      <div className="flex flex-col-reverse w-3/4 bg-[#F8F9FD]">

        <div className="absolute top-4 right-4">
          <button
            type="button"
            className="bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-700 transition duration-200"
            onClick={handleSignOut}
          >
            Sign Out
          </button>
        </div>
      
  
        <div className="flex items-center justify-between border bg-[#f2f0f0] border-[#8C8C8C] py-2 mb-12 mx-20">
          <textarea
            ref={textareaRef}
            className="text-sm w-full outline-none bg-[#f2f0f0] text-black resize-none max-h-32 ml-2 mr-2"
            style={{ maxHeight: "8rem" }}
            maxLength={2096}
          />
          <img
            onClick={handleSubmit}
            className="cursor-pointer w-3 h-3 mr-4"
            src="/send.png"
            alt="send"
          />
        </div>
        <div className="flex-grow overflow-y-auto p-4 h-full">
          {messages.map((message, index) =>
            message.student_sent ? (
              <StudentMessage
                key={message.message_id}
                message={message.message_content}
                isMostRecent={getMostRecentStudentMessageIndex() === index}
                onDelete={() => handleDeleteMessage(message)}
                hasAiMessageAfter={hasAiMessageAfter(
                  messages,
                  getMostRecentStudentMessageIndex()
                )}
              />
            ) : (
              <AIMessage
                key={message.message_id}
                message={message.message_content}
              />
            )
          )}
          {/* ARCH-1: Show streaming text as it arrives, and keep it visible
              until the persisted message replaces it (streamingText is cleared
              in the newMessage useEffect, not when the WebSocket closes). */}
          {streamingText && currentSessionId &&
            session?.session_id && currentSessionId === session.session_id && (
            <AIMessage message={streamingText} />
          )}
          {isAItyping && !streamingText &&
            currentSessionId &&
            session?.session_id &&
            currentSessionId === session.session_id && <TypingIndicator />}
          <div ref={messagesEndRef} />
        </div>
        <div className="font-roboto font-bold text-2xl text-center mt-6 ml-12 mb-6 text-black">
          AI Assistant 🌟
        </div>
      </div>
    </div>
  );
};

export default StudentChat;
