import "@fontsource/fira-sans/400";
import "@fontsource/fira-sans/500";
import "@fontsource/fira-sans/600";
import "@fontsource/fira-code/400";
import "@fontsource/fira-code/500";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
