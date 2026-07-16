import React from "react"
import ReactDOM from "react-dom/client"
import { Toaster } from "sonner"
import "./desktop"
import App from "./App"
import "./styles.css"

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <App />
        <Toaster position="bottom-right" theme="dark" />
    </React.StrictMode>,
)
