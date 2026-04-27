import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Box, Toolbar, Typography, Paper } from "@mui/material";
import apiClient from "../../services/api";
import {
  MRT_TableContainer,
  useMaterialReactTable,
} from "material-react-table";
import { toast } from "react-toastify";
import { titleCase, courseTitleCase } from "../../utils/formatters";



const InstructorConcepts = ({ courseName, course_id }) => {
  const navigate = useNavigate();
  const [data, setData] = useState([]);
  useEffect(() => {
    const fetchConcepts = async () => {
      try {
        const data = await apiClient.get("instructor/view_concepts", { course_id });
        setData(data);
      } catch (error) {
        console.error("Error fetching concepts:", error.message);
      }
    };

    fetchConcepts();
  }, []);

  const columns = useMemo(
    () => [
      {
        accessorKey: "concept_name",
        header: "Concept Name",
        Cell: ({ cell }) => titleCase(cell.getValue())
      },
      {
        accessorKey: "actions",
        header: "Actions",
        Cell: ({ row }) => (
          <Button
            variant="contained"
            color="primary"
            onClick={() => handleEditClick(row.original)}
          >
            Edit
          </Button>
        ),
      },
    ],
    []
  );

  const table = useMaterialReactTable({
    autoResetPageIndex: false,
    columns,
    data,
    enableRowOrdering: true,
    enableSorting: false,
    initialState: { pagination: { pageSize: 1000, pageIndex: 1 } },
    muiRowDragHandleProps: ({ table }) => ({
      onDragEnd: () => {
        const { draggingRow, hoveredRow } = table.getState();
        if (hoveredRow && draggingRow) {
          data.splice(
            hoveredRow.index,
            0,
            data.splice(draggingRow.index, 1)[0]
          );
          setData([...data]);
        }
      },
    }),
  });

  const handleEditClick = (conceptData) => {
    navigate(`/course/${courseName}/edit-concept/${conceptData.concept_id}`, {
      state: { conceptData, course_id: course_id },
    });
  };

  const handleCreateConceptClick = () => {
    navigate(`/course/${courseName}/new-concept`, {
      state: { data, course_id },
    });
  };

  const handleSaveChanges = async () => {
    try {
      // Create an array of promises for updating concepts
      const updatePromises = data.map((concept, index) => {
        const conceptNumber = index + 1;

        return apiClient.putRaw(
          "instructor/edit_concept",
          { concept_id: concept.concept_id, concept_number: conceptNumber },
          { concept_name: concept.concept_name, concept_number: conceptNumber }
        ).then((response) => {
          if (!response.ok) {
            console.error(
              `Failed to update concept ${concept.concept_id}:`,
              response.statusText
            );
            toast.error("Concept Order Update Failed");
            return { success: false };
          } else {
            return response.json().then((updatedConcept) => {
              return { success: true };
            });
          }
        });
      });

      // Wait for all promises to complete
      const updateResults = await Promise.all(updatePromises);
      const allUpdatesSuccessful = updateResults.every(
        (result) => result.success
      );

      if (allUpdatesSuccessful) {
        toast.success("Concept Order Updated Successfully");
      } else {
        toast.error("Some concept updates failed");
      }
    } catch (error) {
      console.error("Error saving changes:", error);
      toast.error("An error occurred while saving changes");
    }
  };

  return (
    <Box
      component="main"
      sx={{ flexGrow: 1, p: 3, marginTop: 1, overflow: "auto" }}
    >
      <Toolbar />
      <Typography
        color="black"
        fontStyle="semibold"
        textAlign="left"
        variant="h6"
      >
        {courseTitleCase(courseName)}
      </Typography>
      <Paper sx={{ width: "100%", overflow: "hidden", marginTop: 2 }}>
        <Box sx={{ maxHeight: "400px", overflowY: "auto" }}>
          <MRT_TableContainer table={table} />
        </Box>
      </Paper>
      <Box
        sx={{
          marginTop: 2,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Button
          variant="contained"
          color="primary"
          onClick={handleCreateConceptClick}
        >
          Create New Concept
        </Button>
        <Button variant="contained" color="primary" onClick={handleSaveChanges}>
          Save Changes
        </Button>
      </Box>
    </Box>
  );
};

export default InstructorConcepts;
