import {
  Typography,
  Box,
  Toolbar,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  TextField,
  Button,
  TableFooter,
  TablePagination,
} from "@mui/material";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import apiClient from "../../services/api";
import { v4 as uuidv4 } from 'uuid';
import { titleCase, courseTitleCase } from "../../utils/formatters";

// populate with dummy data
const createData = (name, email) => {
  return { name, email };
};

const initialRows = [createData("loading...", "loading...")];

export const ViewStudents = ({ courseName, course_id }) => {
  const [rows, setRows] = useState(initialRows);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(5);
  const [loading, setLoading] = useState(false);
  const [accessCode, setAccessCode] = useState("loading...");

  const navigate = useNavigate();

  useEffect(() => {
    const fetchCode = async () => {
      try {
        const codeData = await apiClient.get("instructor/get_access_code", { course_id });
        setAccessCode(codeData.course_access_code);
      } catch (error) {
        console.error("Error fetching courses:", error.message);
      }
    };

    fetchCode();
  }, [course_id]);

  // retrieve analytics data
  useEffect(() => {
    const fetchStudents = async () => {
      try {
        const data = await apiClient.get("instructor/view_students", { course_id });
        const formattedData = data.map((student) => {
          return createData(
            `${titleCase(student.first_name)} ${titleCase(
              student.last_name
            )}`,
            student.user_email
          );
        });
        setRows(formattedData);
      } catch (error) {
        console.error("Error fetching data:", error.message);
      }
    };

    fetchStudents();
  }, []);
  
  const handleGenerateAccessCode = async () => {
    try {
      const codeData = await apiClient.put("instructor/generate_access_code", { course_id });
      setAccessCode(codeData.access_code);
    } catch (error) {
      console.error("Error fetching courses:", error.message);
    }
  };
  const handleSearchChange = (event) => {
    setSearchQuery(event.target.value);
  };

  const handleChangePage = (event, newPage) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const filteredRows = rows.filter((row) =>
    row.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const handleRowClick = (student) => {
    navigate(`/course/${courseName}/student/${student.name}`, {
      state: { course_id, student },
    });
  };

  return (
    <div>
      <Box component="main" sx={{ flexGrow: 1, p: 3, marginTop: 1 }}>
        <Toolbar />
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            width: "170%",
            marginTop: 2,
          }}
        >
          <Typography
            color="black"
            fontStyle="semibold"
            textAlign="left"
            variant="h6"
          >
            {courseTitleCase(courseName)} Students
          </Typography>
        </Box>
        <Paper sx={{ width: "170%", overflow: "hidden", marginTop: 2 }}>
          <TableContainer sx={{ maxHeight: "50vh", overflowY: "auto" }}>
            <TextField
              label="Search by Student"
              variant="outlined"
              value={searchQuery}
              onChange={handleSearchChange}
              sx={{ margin: 2, width: "95%", alignContent: "left" }}
            />
            <Table aria-label="student table">
              {!loading ? (
                <>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: "50%" }}>Student</TableCell>
                      <TableCell>Email</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredRows && filteredRows.length > 0 ? (
                      filteredRows
                        .slice(
                          page * rowsPerPage,
                          page * rowsPerPage + rowsPerPage
                        )
                        .map((row, index) => (
                          <TableRow
                            key={index}
                            onClick={() => handleRowClick(row)}
                            style={{ cursor: "pointer" }}
                          >
                            <TableCell>{row.name}</TableCell>
                            <TableCell>{row.email}</TableCell>
                          </TableRow>
                        ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={2} align="center">
                          No students enrolled in course
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </>
              ) : (
                <>loading...</>
              )}
              <TableFooter>
                <TableRow>
                  <TablePagination
                    rowsPerPageOptions={[5, 10, 25]}
                    component="div"
                    count={filteredRows.length}
                    rowsPerPage={rowsPerPage}
                    page={page}
                    onPageChange={handleChangePage}
                    onRowsPerPageChange={handleChangeRowsPerPage}
                  />
                </TableRow>
              </TableFooter>
            </Table>
          </TableContainer>
        </Paper>
        <Paper
          sx={{
            marginTop: 5,
            marginLeft: 25,
            display: "flex-start",
            p: 5,
            width: "100%",
          }}
        >
          <Typography variant="subtitle1" color="black">
            Access Code: {accessCode}
          </Typography>
          <Button
            variant="contained"
            color="primary"
            onClick={handleGenerateAccessCode}
          >
            Generate New Access Code
          </Button>
        </Paper>
      </Box>
    </div>
  );
};

export default ViewStudents;
