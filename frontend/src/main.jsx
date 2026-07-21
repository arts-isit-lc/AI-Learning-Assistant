import React from "react";
import ReactDOM from "react-dom/client";
import { Amplify } from "aws-amplify";
import AppV2 from "./app/AppV2.jsx";
import "./index.css";
import "katex/dist/katex.min.css";

// Amplify (auth + REST) configuration — runs once at startup, before the app
// renders. Values come from the Vite env (set by the CDK output).
Amplify.configure({
  API: {
    REST: {
      MyApi: {
        endpoint: import.meta.env.VITE_API_ENDPOINT,
      },
    },
  },
  Auth: {
    Cognito: {
      region: import.meta.env.VITE_AWS_REGION,
      userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      allowGuestAccess: false,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <AppV2 />
  </React.StrictMode>
);
