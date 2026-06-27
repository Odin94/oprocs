import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import path from "path"

export default defineConfig({
    main: {
        build: {
            rollupOptions: {
                input: {
                    index: path.resolve(__dirname, "src/main/index.ts"),
                    watchdog: path.resolve(__dirname, "src/main/watchdog.ts"),
                },
            },
        },
    },
    preload: {
        build: {
            rollupOptions: {
                output: {
                    format: "cjs",
                    entryFileNames: "[name].cjs",
                },
            },
        },
    },
    renderer: {
        resolve: {
            alias: {
                "@shared": path.resolve(__dirname, "src/shared"),
            },
        },
        plugins: [react()],
    },
})
