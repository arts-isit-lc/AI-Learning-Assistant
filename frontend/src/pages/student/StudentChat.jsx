import { useEffect, useRef, useState } from "react";
import AIMessage from "../../components/AIMessage";
import Session from "../../components/Session";
import StudentMessage from "../../components/StudentMessage";
import FileViewerPanel from "../../components/FileViewerPanel";
import apiClient from "../../services/api";
import { useNavigate } from "react-router-dom";
import { signOut } from "aws-amplify/auth";
import ArrowCircleLeftRoundedIcon from "@mui/icons-material/ArrowCircleLeftRounded";
import { FileText } from "lucide-react";
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
  const [retryError, setRetryError] = useState(null); // { sessionId, sessionName, messageContent, source }
  const [moduleFiles, setModuleFiles] = useState(null); // null = not yet fetched
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesPopoverOpen, setFilesPopoverOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [pdfPanelOpen, setPdfPanelOpen] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
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

        // P-7: Show message optimistically
        setNewMessage({
          message_id: `opt-${Date.now()}`,
          message_content: messageContent,
          student_sent: true,
          session_id: newSession.session_id,
          time_sent: new Date().toISOString(),
        });
        setIsAItyping(true);
        textareaRef.current.value = "";

        // ARCH-1: Subscribe to streaming chunks before firing chatbot-v2
        subscribeToChunks(newSession.session_id);

        // V2: Single call replaces create_message + text_generation + create_ai_message
        return apiClient.postRaw(
          "student/chatbot-v2",
          { course_id: course.course_id, session_id: newSession.session_id, module_id: module.module_id, session_name: newSession.session_name },
          { message_content: messageContent }
        );
      })
      .then((textGenResponse) => {
        if (!textGenResponse.ok) {
          throw new Error(
            `Failed to generate text: ${textGenResponse.statusText}`
          );
        }
        return textGenResponse.json();
      })
      .then((textGenData) => {
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

        // V2 persists messages to RDS internally — just display the AI response
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

    // V2: Single call handles message persistence + AI generation
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

        setSession((prevSession) => ({
          ...prevSession,
          session_name: autoName,
        }));

        setSessions((prevSessions) =>
          prevSessions.map((s) =>
            s.session_id === sessionId
              ? { ...s, session_name: titleCase(autoName) }
              : s
          )
        );

        // Display the AI response directly — V2 handles RDS persistence internally
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
          apiClient.putRaw(
            "student/update_session_name",
            { session_id: sessionId },
            { session_name: autoName }
          ),
          apiClient.postRaw(
            "student/update_module_score",
            { module_id: module.module_id, student_email: email, course_id: course.course_id, llm_verdict: textGenData.llm_verdict }
          ),
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

        // ARCH-1: Subscribe to streaming chunks before firing chatbot-v2
        subscribeToChunks(sessionData.session_id);

        // V2: Single call handles initial greeting + message persistence
        return apiClient.postRaw(
          "student/chatbot-v2",
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
        // Display AI greeting directly — V2 handles RDS persistence internally
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
          setRetryError({
            sessionId: sessionData.session_id,
            sessionName: "New chat",
            messageContent: null,
            source: "newChat",
          });
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

  // PDF Viewer handlers
  const handleFetchFiles = async () => {
    if (moduleFiles !== null) {
      // Already fetched — use cached list
      setFilesPopoverOpen(true);
      return;
    }
    setFilesLoading(true);
    setFilesPopoverOpen(true);
    try {
      const data = await apiClient.get("student/files", {
        course_id: course.course_id,
        module_id: module.module_id,
      });
      setModuleFiles(data || []);
    } catch (error) {
      console.error("Error fetching module files:", error.message);
      setModuleFiles([]);
    } finally {
      setFilesLoading(false);
    }
  };

  const handleFileSelect = async (fileId) => {
    const file = moduleFiles?.find((f) => f.file_id === fileId);
    setSelectedFile(file);
    setPdfLoading(true);
    setPdfPanelOpen(true);
    setFilesPopoverOpen(false);
    try {
      const data = await apiClient.get("student/file_url", {
        file_id: fileId,
      });
      setPdfUrl(data.presignedurl);
    } catch (error) {
      console.error("Error fetching file URL:", error.message);
      setPdfUrl(null);
    } finally {
      setPdfLoading(false);
    }
  };

  const handlePdfClose = () => {
    setPdfPanelOpen(false);
    setSelectedFile(null);
    setPdfUrl(null);
  };

  const handlePdfRetry = async () => {
    if (!selectedFile) return;
    setPdfLoading(true);
    try {
      const data = await apiClient.get("student/file_url", {
        file_id: selectedFile.file_id,
      });
      setPdfUrl(data.presignedurl);
    } catch (error) {
      console.error("Error fetching file URL on retry:", error.message);
    } finally {
      setPdfLoading(false);
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
      // Preserve blocks from the most recent in-memory messages (blocks aren't persisted in RDS yet)
      setMessages((prevMessages) => {
        // Build a map of blocks keyed by message_content (since message_ids differ between live and RDS)
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
      <div className={`flex flex-col ${pdfPanelOpen ? 'w-1/5' : 'w-1/4'} bg-gradient-to-tr from-purple-300 to-cyan-100 transition-all duration-200`}>
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
      <div className={`flex flex-col-reverse ${pdfPanelOpen ? 'w-2/5' : 'w-3/4'} bg-[#F8F9FD] transition-all duration-200`}>

        <div className="absolute top-4 right-4 flex items-center gap-2">
          {/* View Materials button */}
          <div className="relative">
            <button
              type="button"
              className="flex items-center gap-2 bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-700 transition duration-200"
              onClick={handleFetchFiles}
            >
              <FileText className="w-4 h-4" />
              <span className="hidden sm:inline">View Materials</span>
            </button>

            {/* File list popover */}
            {filesPopoverOpen && (
              <div className="absolute right-0 top-12 z-40 w-64 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                <div className="flex items-center justify-between p-3 border-b border-gray-200">
                  <span className="text-sm font-medium text-gray-900">Module Files</span>
                  <button
                    onClick={() => setFilesPopoverOpen(false)}
                    className="text-gray-400 hover:text-gray-600"
                    aria-label="Close file list"
                  >
                    ×
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {filesLoading ? (
                    <div className="p-3 space-y-2">
                      <div className="h-8 bg-gray-100 rounded animate-pulse" />
                      <div className="h-8 bg-gray-100 rounded animate-pulse" />
                      <div className="h-8 bg-gray-100 rounded animate-pulse" />
                    </div>
                  ) : moduleFiles && moduleFiles.length > 0 ? (
                    <div className="py-1">
                      {moduleFiles.map((f) => (
                        <button
                          key={f.file_id}
                          onClick={() => handleFileSelect(f.file_id)}
                          className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2 transition-colors"
                        >
                          <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                          <span className="text-sm text-gray-700 truncate">{f.filename}</span>
                          <span className="text-xs text-gray-400 uppercase shrink-0">{f.filetype}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="p-4 text-center">
                      <p className="text-sm text-gray-500">No materials available</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

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
                blocks={message.blocks}
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
          {retryError && !isAItyping && (
            <div className="flex items-center ml-28 mb-4 gap-3">
              <span className="text-sm text-red-600">Something went wrong generating a response.</span>
              <button
                onClick={handleRetry}
                className="text-sm font-medium text-white bg-red-500 hover:bg-red-600 px-3 py-1 rounded transition duration-200"
              >
                Retry
              </button>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <div className="font-roboto font-bold text-2xl text-center mt-6 ml-12 mb-6 text-black">
          AI Assistant 🌟
        </div>
      </div>

      {/* File Viewer Panel */}
      {pdfPanelOpen && (
        <div className="hidden md:block w-2/5 h-full transition-all duration-200">
          <FileViewerPanel
            file={selectedFile}
            fileUrl={pdfUrl}
            files={moduleFiles}
            onFileSelect={handleFileSelect}
            onClose={handlePdfClose}
            onRetry={handlePdfRetry}
            loading={pdfLoading}
          />
        </div>
      )}
      {/* Mobile: File panel renders as full-screen overlay from within FileViewerPanel */}
      {pdfPanelOpen && (
        <div className="md:hidden">
          <FileViewerPanel
            file={selectedFile}
            fileUrl={pdfUrl}
            files={moduleFiles}
            onFileSelect={handleFileSelect}
            onClose={handlePdfClose}
            onRetry={handlePdfRetry}
            loading={pdfLoading}
          />
        </div>
      )}
    </div>
  );
};

export default StudentChat;
