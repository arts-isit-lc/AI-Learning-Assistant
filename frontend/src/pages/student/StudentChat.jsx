import { useEffect, useRef } from "react";
import AIMessage from "../../components/AIMessage";
import Session from "../../components/Session";
import StudentMessage from "../../components/StudentMessage";
import FileViewerPanel from "../../components/FileViewerPanel";
import { useNavigate } from "react-router-dom";
import ArrowCircleLeftRoundedIcon from "@mui/icons-material/ArrowCircleLeftRounded";
import { FileText } from "lucide-react";
import { titleCase } from "../../utils/formatters";
import { handleSignOut } from "../../utils/auth";
import TypingIndicator from "./TypingIndicator";
import useChatSession from "./useChatSession";
import useFileViewer from "./useFileViewer";

const StudentChat = ({ course, module, setModule, setCourse }) => {
  const messagesEndRef = useRef(null);
  const navigate = useNavigate();

  const chat = useChatSession(course, module);
  const files = useFileViewer(course, module);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chat.messages]);

  // Textarea auto-resize + keyboard handling
  useEffect(() => {
    const textarea = chat.textareaRef.current;
    if (!textarea) return;

    const handleResize = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
      if (textarea.scrollHeight > parseInt(textarea.style.maxHeight)) {
        textarea.style.overflowY = "auto";
      } else {
        textarea.style.overflowY = "hidden";
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        chat.handleSubmit();
      }
    };

    handleResize();
    textarea.addEventListener("input", handleResize);
    textarea.addEventListener("keydown", handleKeyDown);

    return () => {
      textarea.removeEventListener("input", handleResize);
      textarea.removeEventListener("keydown", handleKeyDown);
    };
  }, [chat.textareaRef.current, chat.handleSubmit]);

  // Restore module/course from sessionStorage
  useEffect(() => {
    const storedModule = sessionStorage.getItem("module");
    if (storedModule) setModule(JSON.parse(storedModule));
  }, [setModule]);

  useEffect(() => {
    const storedCourse = sessionStorage.getItem("course");
    if (storedCourse) setCourse(JSON.parse(storedCourse));
  }, [setCourse]);

  const handleBack = () => {
    sessionStorage.removeItem("module");
    navigate(-1);
  };

  if (!module) {
    return <div>Loading...</div>;
  }

  const mostRecentStudentIdx = chat.getMostRecentStudentMessageIndex();

  return (
    <div className="flex flex-row h-screen">
      {/* Sidebar */}
      <div className={`flex flex-col ${files.pdfPanelOpen ? 'w-1/5' : 'w-1/4'} bg-gradient-to-tr from-purple-300 to-cyan-100 transition-all duration-200`}>
        <div className="flex flex-row mt-3 mb-3 ml-4">
          <ArrowCircleLeftRoundedIcon
            onClick={handleBack}
            className="cursor-pointer"
            sx={{ width: 32, height: 32 }}
          />
          <div className="ml-3 pt-0.5 text-black font-roboto font-bold text-lg">
            {titleCase(module.module_name)}
          </div>
        </div>
        <button
          onClick={() => {
            if (!chat.creatingSession) {
              chat.setCreatingSession(true);
              chat.handleNewChat();
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
        <div className="overflow-y-auto mt-2 mb-6">
          {chat.sessions
            .slice()
            .reverse()
            .map((iSession) => (
              <Session
                key={iSession.session_id}
                text={iSession.session_name}
                session={iSession}
                setSession={chat.setSession}
                deleteSession={chat.handleDeleteSession}
                selectedSession={chat.session}
                setMessages={chat.setMessages}
                setSessions={chat.setSessions}
                sessions={chat.sessions}
              />
            ))}
        </div>
      </div>

      {/* Main chat area */}
      <div className={`flex flex-col-reverse ${files.pdfPanelOpen ? 'w-2/5' : 'w-3/4'} bg-[#F8F9FD] transition-all duration-200`}>

        {/* Top-right actions */}
        <div className="absolute top-4 right-4 flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              className="flex items-center gap-2 bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-700 transition duration-200"
              onClick={files.handleFetchFiles}
            >
              <FileText className="w-4 h-4" />
              <span className="hidden sm:inline">View Materials</span>
            </button>

            {/* File list popover */}
            {files.filesPopoverOpen && (
              <div className="absolute right-0 top-12 z-40 w-64 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                <div className="flex items-center justify-between p-3 border-b border-gray-200">
                  <span className="text-sm font-medium text-gray-900">Module Files</span>
                  <button
                    onClick={() => files.setFilesPopoverOpen(false)}
                    className="text-gray-400 hover:text-gray-600"
                    aria-label="Close file list"
                  >
                    ×
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {files.filesLoading ? (
                    <div className="p-3 space-y-2">
                      <div className="h-8 bg-gray-100 rounded animate-pulse" />
                      <div className="h-8 bg-gray-100 rounded animate-pulse" />
                      <div className="h-8 bg-gray-100 rounded animate-pulse" />
                    </div>
                  ) : files.moduleFiles && files.moduleFiles.length > 0 ? (
                    <div className="py-1">
                      {files.moduleFiles.map((f) => (
                        <button
                          key={f.file_id}
                          onClick={() => files.handleFileSelect(f.file_id)}
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

        {/* Chat input */}
        <div className="flex items-center justify-between border bg-[#f2f0f0] border-[#8C8C8C] py-2 mb-12 mx-20">
          <textarea
            ref={chat.textareaRef}
            className="text-sm w-full outline-none bg-[#f2f0f0] text-black resize-none max-h-32 ml-2 mr-2"
            style={{ maxHeight: "8rem" }}
            maxLength={2096}
          />
          <img
            onClick={chat.handleSubmit}
            className="cursor-pointer w-3 h-3 mr-4"
            src="/send.png"
            alt="send"
          />
        </div>

        {/* Message thread */}
        <div className="flex-grow overflow-y-auto p-4 h-full">
          {chat.messages.map((message, index) =>
            message.student_sent ? (
              <StudentMessage
                key={message.message_id}
                message={message.message_content}
                isMostRecent={mostRecentStudentIdx === index}
                onDelete={() => chat.handleDeleteMessage()}
                hasAiMessageAfter={chat.hasAiMessageAfter(mostRecentStudentIdx)}
              />
            ) : (
              <AIMessage
                key={message.message_id}
                blocks={message.blocks}
                message={message.message_content}
              />
            )
          )}
          {/* Streaming text */}
          {chat.streamingText && chat.currentSessionId &&
            chat.session?.session_id && chat.currentSessionId === chat.session.session_id && (
            <AIMessage message={chat.streamingText} />
          )}
          {/* Typing indicator */}
          {chat.isAItyping && !chat.streamingText &&
            chat.currentSessionId &&
            chat.session?.session_id &&
            chat.currentSessionId === chat.session.session_id && <TypingIndicator />}
          {/* Retry banner */}
          {chat.retryError && !chat.isAItyping && (
            <div className="flex items-center ml-28 mb-4 gap-3">
              <span className="text-sm text-red-600">Something went wrong generating a response.</span>
              <button
                onClick={chat.handleRetry}
                className="text-sm font-medium text-white bg-red-500 hover:bg-red-600 px-3 py-1 rounded transition duration-200"
              >
                Retry
              </button>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Header */}
        <div className="font-roboto font-bold text-2xl text-center mt-6 ml-12 mb-6 text-black">
          AI Assistant 🌟
        </div>
      </div>

      {/* File Viewer Panel — Desktop */}
      {files.pdfPanelOpen && (
        <div className="hidden md:block w-2/5 h-full transition-all duration-200">
          <FileViewerPanel
            file={files.selectedFile}
            fileUrl={files.pdfUrl}
            files={files.moduleFiles}
            onFileSelect={files.handleFileSelect}
            onClose={files.handlePdfClose}
            onRetry={files.handlePdfRetry}
            loading={files.pdfLoading}
          />
        </div>
      )}
      {/* File Viewer Panel — Mobile overlay */}
      {files.pdfPanelOpen && (
        <div className="md:hidden">
          <FileViewerPanel
            file={files.selectedFile}
            fileUrl={files.pdfUrl}
            files={files.moduleFiles}
            onFileSelect={files.handleFileSelect}
            onClose={files.handlePdfClose}
            onRetry={files.handlePdfRetry}
            loading={files.pdfLoading}
          />
        </div>
      )}
    </div>
  );
};

export default StudentChat;
