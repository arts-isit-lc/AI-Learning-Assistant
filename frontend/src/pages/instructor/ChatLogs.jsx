import {
    Typography,
    Box,
    Toolbar,
    Paper,
    Button,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow
} from "@mui/material";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import apiClient from "../../services/api";
import { v4 as uuidv4 } from 'uuid';
import { useNotification } from "../../context/NotificationContext";
import { courseTitleCase } from "../../utils/formatters";

export const ChatLogs = ({ courseName, course_id, openWebSocket }) => {
    const [loading, setLoading] = useState(false);
    const [isDownloadButtonEnabled, setIsDownloadButtonEnabled] = useState(false);
    const [previousChatLogs, setPreviousChatLogs] = useState([]);
    const { setNotificationForCourse } = useNotification();

    useEffect(() => {
        checkNotificationStatus();
        fetchChatLogs();

        // Auto-refresh logs every 5 minutes since presigned URLs expire
        const interval = setInterval(fetchChatLogs, 5 * 60 * 1000);
        return () => clearInterval(interval);
    }, [course_id]);

    const checkNotificationStatus = async () => {
        try {
            const { email } = await apiClient.getAuth();
            const data = await apiClient.get("instructor/check_notifications_status", {
                course_id,
                instructor_email: email,
            });
            console.log(`Download Chatlogs is ${data.isEnabled}`)
            setIsDownloadButtonEnabled(data.isEnabled);
        } catch (error) {
            console.error("Error checking notification status:", error.message);
        }
    };

    const fetchChatLogs = async () => {
        try {
            setLoading(true);
            const { email } = await apiClient.getAuth();

            const data = await apiClient.get("instructor/fetch_chatlogs", {
                course_id,
                instructor_email: email,
            });
            console.log("Chat logs fetched:", data);
            if (data.log_files) {
                const formattedLogs = Object.entries(data.log_files).map(([fileName, presignedUrl]) => ({
                    date: convertToLocalTime(fileName), // Using file name as the date
                    presignedUrl: presignedUrl,
                }));
                setPreviousChatLogs(formattedLogs);
            } else {
                setPreviousChatLogs([]);
            }
        } catch (error) {
            console.error("Error fetching chat logs:", error.message);
        } finally {
            setLoading(false);
        }
    };

    const convertToLocalTime = (fileName) => {
        try {
            // Extract timestamp from file name (assuming format: "YYYY-MM-DD HH:MM:SS.csv")
            const match = fileName.match(/(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})/);
            if (!match) {
                console.warn("Could not extract a valid timestamp from filename:", fileName);
                return fileName; // Return original name if no timestamp found
            }
    
            // Extract date components
            const [_, datePart, hours, minutes, seconds] = match;
            const [year, month, day] = datePart.split("-").map(Number);
    
            // Create a new Date object with UTC time
            const utcDate = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
    
            // Convert to user's local time
            return utcDate.toLocaleString(undefined, { timeZoneName: "short" });
    
        } catch (error) {
            console.error("Error converting time:", error);
            return fileName; // Fallback in case of error
        }
    };
    


    const downloadChatLog = (presignedUrl) => {
        try {
            console.log("Downloading file from:", presignedUrl);
            window.open(presignedUrl, "_blank");
        } catch (error) {
            console.error("Error downloading file:", error);
        }
    };

    const generateCourseMessages = async () => {
        try {
            console.log("openWebSocket function:", openWebSocket);
            if (typeof openWebSocket !== "function") {
                console.error("Error: openWebSocket is not a function!");
                return;
            }
            setIsDownloadButtonEnabled(false);
            const { email } = await apiClient.getAuth();
            const request_id = uuidv4();

            const data = await apiClient.post("instructor/course_messages", {}, {
                course_id: course_id,
                instructor_email: email,
                request_id: request_id,
            });

            console.log("Job submitted successfully:", data);

            // Invoke global WebSocket function from InstructorHomepage and delay checkNotificationStatus slightly
            openWebSocket(courseName, course_id, request_id, setNotificationForCourse, () => {
                console.log("Waiting before checking notification status...");
                setTimeout(() => {
                    checkNotificationStatus();
                    fetchChatLogs(); // Fetch latest chat logs after WebSocket completes
                }, 2000); // Wait 2 seconds before checking
            });
        } catch (error) {
            console.error("Error submitting job:", error.message);
        }
    };


    return (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", flexDirection: "column", width: "100%" }}>
            <Box component="main" sx={{ flexGrow: 1, p: 3, marginTop: 1, display: "flex", flexDirection: "column", alignItems: "center", width: "90%" }}>
                <Toolbar />
                <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", width: "100%", gap: 2, marginTop: 2, flexWrap: "wrap" }}>
                    <Typography color="black" variant="h6" sx={{ fontStyle: "italic", textAlign: "center" }}>
                        {courseName} Chat Logs
                    </Typography>
                    <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "170%", marginTop: 2, flexDirection: "column", }}>
                        <Button
                            variant="contained"
                            color="primary"
                            onClick={generateCourseMessages}
                            disabled={!isDownloadButtonEnabled}
                        >
                            Generate Classroom Chatlogs
                        </Button>
                    </Box>
                </Box>
                <Paper sx={{ marginTop: 2, flexGrow: 1, height: "calc(100vh - 270px)", overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", padding: 2, width: "100%" }}>
                    {loading ? (
                        <Typography variant="body1" color="textSecondary" sx={{ textAlign: "center" }}>
                            Loading chat logs...
                        </Typography>
                    ) : null }
                    {!loading && previousChatLogs.length > 0 && (
                        <TableContainer component={Paper} sx={{ marginTop: 2, overflowY: "auto", width: "100%" }}>
                            <Table sx={{ width: "100%" }}>
                                <TableHead>
                                    <TableRow>
                                        <TableCell sx={{ width: "50%", textAlign: "center" }}><strong>Date</strong></TableCell>
                                        <TableCell sx={{ width: "50%", textAlign: "center" }}><strong>Download</strong></TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {previousChatLogs.map((log, index) => (
                                        <TableRow key={index}>
                                            <TableCell sx={{ width: "50%", textAlign: "center" }}>{log.date}</TableCell>
                                            <TableCell sx={{ width: "50%", textAlign: "center" }}>
                                                <Button variant="contained" color="primary" onClick={() => window.open(log.presignedUrl, "_blank")}>
                                                    Download
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </Paper>

            </Box>
        </div>
    );
};

export default ChatLogs;