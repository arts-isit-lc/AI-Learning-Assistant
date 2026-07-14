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
  TableFooter,
  TablePagination,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Button,
} from "@mui/material";
import { useState, useEffect } from "react";
import apiClient from "../../services/api";

import { toast } from "react-toastify";
import { titleCase } from "../../utils/formatters";

const fetchInstructors = async () => {
  try {
    const { email } = await apiClient.getAuth();
    const data = await apiClient.get("admin/instructors", { instructor_email: email });
    return data;
  } catch (error) {
    console.error("Error fetching instructors:", error.message);
    return [];
  }
};

const createData = (user, last, email) => {
  return { user, last, email };
};

function getInstructorInfo(coursesArray) {
  return coursesArray.map((instructor) =>
    createData(
      instructor.first_name || "Waiting for user to sign up",
      instructor.last_name || "Waiting for user to sign up",
      instructor.user_email
    )
  );
}

export const AdminInstructors = ({ setSelectedInstructor }) => {
  const [rows, setRows] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(5);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const handleClickOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  // Single source of truth: always load the instructor list from the backend
  // so the table reflects what is actually persisted, not local-only state.
  const loadInstructors = async () => {
    try {
      const data = await fetchInstructors();
      setRows(getInstructorInfo(data));
    } catch (error) {
      console.error("Error loading instructors:", error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInstructors();
  }, []);

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

  const filteredRows = rows.filter(
    (row) =>
      row &&
      row.user &&
      row.user.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleRowClick = (user) => {
    setSelectedInstructor(user);
  };

  const handleAddInstructor = async (email) => {
    const existingInstructor = rows.find((row) => row.email === email);
    if (existingInstructor) {
      toast.error(`Instructor with email ${email} already exists.`);
      return;
    }

    try {
      const result = await apiClient.post("admin/elevate_instructor", { email });
      toast.success(result?.message || `Instructor with email ${email} elevated`);
      // Close the dialog and re-fetch so the table shows the persisted row.
      handleClose();
      await loadInstructors();
    } catch (error) {
      console.error("Error elevating instructor", error.message);
      toast.error("Failed to add instructor. Please try again.");
    }
  };

  return (
    <div>
      <Box component="main" sx={{ flexGrow: 1, p: 2, marginTop: 0.5 }}>
        <Toolbar />
        <Paper
          sx={{
            width: "150%",
            overflow: "hidden",
            marginTop: 1,
            borderRadius: 2,
          }}
        >
          <Box
            sx={{
              padding: 2,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Typography
              color="black"
              fontStyle="semibold"
              textAlign="left"
              variant="h6"
            >
              Manage Instructors
            </Typography>
          </Box>
          <TableContainer
            sx={{
              maxHeight: "70vh",
              overflowY: "auto",
            }}
          >
            <TextField
              label="Search by User"
              variant="outlined"
              value={searchQuery}
              onChange={handleSearchChange}
              sx={{ margin: 1, width: "90%" }}
              InputProps={{ sx: { fontSize: 14 } }}
              InputLabelProps={{ sx: { fontSize: 14 } }}
            />
            <Table aria-label="instructors table">
              {!loading ? (
                <>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: "30%", fontSize: 14 }}>
                        First Name
                      </TableCell>
                      <TableCell sx={{ fontSize: 14 }}>Last Name</TableCell>
                      <TableCell sx={{ fontSize: 14 }}>Email</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredRows
                      .slice(
                        page * rowsPerPage,
                        page * rowsPerPage + rowsPerPage
                      )
                      .map((row, index) => (
                        <TableRow
                          key={index}
                          onClick={() => handleRowClick({row})}
                          style={{ cursor: "pointer" }}
                        >
                          <TableCell sx={{ fontSize: 14 }}>
                            {titleCase(row.user)}
                          </TableCell>
                          <TableCell sx={{ fontSize: 14 }}>
                            {titleCase(row.last)}
                          </TableCell>
                          <TableCell sx={{ fontSize: 14 }}>
                            {row.email}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </>
              ) : (
                <TableBody>loading...</TableBody>
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
                    sx={{
                      fontSize: 14,
                      minWidth: 400,
                    }}
                  />
                </TableRow>
              </TableFooter>
            </Table>
          </TableContainer>

          <Button
            variant="contained"
            color="primary"
            sx={{ marginBottom: 2 }}
            onClick={handleClickOpen}
          >
            Add Instructors
          </Button>
        </Paper>
      </Box>
      <Dialog
        open={open}
        onClose={handleClose}
        slotProps={{
          paper: {
            component: "form",
            onSubmit: (event) => {
              event.preventDefault();
              const formData = new FormData(event.currentTarget);
              const formJson = Object.fromEntries(formData.entries());
              const email = formJson.email;
              handleAddInstructor(email);
            },
          },
        }}
      >
        <DialogTitle>Add an Instructor</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Please enter the email of the instructor here
          </DialogContentText>
          <TextField
            autoFocus
            required
            margin="dense"
            id="name"
            name="email"
            label="Email Address"
            type="email"
            fullWidth
            variant="standard"
            inputProps={{ maxLength: 40 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>Cancel</Button>
          <Button type="submit">Submit</Button>
        </DialogActions>
      </Dialog>
    </div>
  );
};

export default AdminInstructors;
