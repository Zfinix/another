import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MirrorApp from "./MirrorApp";
import { mirrorIdentity } from "./lib/mirror";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {mirrorIdentity ? <MirrorApp identity={mirrorIdentity} /> : <App />}
  </React.StrictMode>,
);
