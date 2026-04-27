import React, { useState, useEffect } from "react";
import apiClient from "../../services/api";
import {
  Container,
  Typography,
  Box,
  Tabs,
  Tab,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  LinearProgress,
  Grid,
  Paper,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { titleCase, courseTitleCase } from "../../utils/formatters";

const InstructorAnalytics = ({ courseName, course_id }) => {
  const [value, setValue] = useState(0);
  const [graphData, setGraphData] = useState([]);
  const [data, setData] = useState([]);
  const [maxMessages, setMaxMessages] = useState(0);

  useEffect(() => {
    const fetchAnalytics = async () => {
      try {
        const analytics_data = await apiClient.get("instructor/analytics", { course_id });
        setData(analytics_data);
        const graphDataFormatted = analytics_data.map((module) => ({
          module: module.module_name,
          Messages: module.message_count,
        }));
        setGraphData(graphDataFormatted);
      } catch (error) {
        console.error("Error fetching analytics:", error.message);
      }
    };

    fetchAnalytics();
  }, [course_id]);

  useEffect(() => {
    if (graphData.length > 0) {
      const max = Math.max(...graphData.map((data) => data.Messages));
      setMaxMessages(max);
    }
  }, [graphData]);

  const handleChange = (event, newValue) => {
    setValue(newValue);
  };

  return (
    <Container sx={{ flexGrow: 1, p: 3, marginTop: 9, overflow: "auto" }}>
      <Typography
        color="black"
        fontStyle="semibold"
        textAlign="left"
        variant="h6"
        gutterBottom
      >
        {courseTitleCase(courseName)}
      </Typography>
      <Paper>
        <Box sx={{ mb: 4 }}>
          <Typography
            color="black"
            textAlign="left"
            paddingLeft={10}
            padding={2}
          >
            Message Count
          </Typography>
          {graphData.length > 0 ? (
            <LineChart
              width={900}
              height={300}
              data={graphData}
              margin={{
                top: 5,
                right: 30,
                left: 20,
                bottom: 5,
              }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="module"
                tick={{ fontSize: 12 }}
                tickFormatter={(tick) => titleCase(tick)}
              />
              <YAxis domain={[0, maxMessages + 3]} />
              <Tooltip />
              <Legend />
              <Line
                type="monotone"
                dataKey="Messages"
                stroke="#8884d8"
                activeDot={{ r: 8 }}
              />
            </LineChart>
          ) : (
            <Typography
              variant="h6"
              color="textSecondary"
              textAlign="center"
              padding={4}
            >
              No data found
            </Typography>
          )}
        </Box>
      </Paper>

      <Tabs value={value} onChange={handleChange} aria-label="grade tabs">
        <Tab label="Insights" />
      </Tabs>

      {value === 0 ? (
        data.length > 0 ? (
          <Box sx={{ mt: 2 }}>
            {data.map((module, index) => (
              <Accordion key={index}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography>{titleCase(module.module_name)}</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Box sx={{ width: "100%" }}>
                    <Grid
                      container
                      spacing={1}
                      alignItems="center"
                      direction="column"
                      sx={{ width: '100%' }}
                    >
                      <Grid size={{ xs: 12 }} sx={{ width: "80%" }}>
                        <Typography sx={{ textAlign: "right" }}>
                          Completion Percentage:{" "}
                          {module.perfect_score_percentage.toFixed(2)}%
                        </Typography>
                        <LinearProgress
                          variant="determinate"
                          value={module.perfect_score_percentage}
                        />
                      </Grid>
                      <Grid>
                        <Typography>Message Count</Typography>
                        <Typography>{module.message_count}</Typography>
                      </Grid>
                      <Grid>
                        <Typography>Access Count</Typography>
                        <Typography>{module.access_count}</Typography>
                      </Grid>
                    </Grid>
                  </Box>
                </AccordionDetails>
              </Accordion>
            ))}
          </Box>
        ) : (
          <Typography
            variant="h6"
            color="textSecondary"
            textAlign="center"
            padding={4}
          >
            No insights available
          </Typography>
        )
      ) : null}
    </Container>
  );
};

export default InstructorAnalytics;