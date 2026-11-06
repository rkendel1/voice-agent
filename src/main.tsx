import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@feltdb/feltkit/client";
import { FeltKitProvider } from "@feltdb/feltkit/react";
import { App } from "./App";
import "./styles.css";

// Same origin as the page: the dev server serves the app, its functions, AppPort and Studio together.
const client = createClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeltKitProvider client={client}>
      <App />
    </FeltKitProvider>
  </StrictMode>,
);
