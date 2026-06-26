/** @type {import('tailwindcss').Config} */
export default {
    content: ["./src/renderer/index.html", "./src/renderer/**/*.{ts,tsx}"],
    theme: {
        extend: {
            fontFamily: {
                sans: ["Inter", "system-ui", "sans-serif"],
                mono: ["JetBrains Mono", "monospace"],
            },
            colors: {
                border: "hsl(var(--border))",
                input: "hsl(var(--input))",
                ring: "hsl(var(--ring))",
                background: "hsl(var(--background))",
                foreground: "hsl(var(--foreground))",
                primary: {
                    DEFAULT: "hsl(var(--primary))",
                    foreground: "hsl(var(--primary-foreground))",
                },
                secondary: {
                    DEFAULT: "hsl(var(--secondary))",
                    foreground: "hsl(var(--secondary-foreground))",
                },
                destructive: {
                    DEFAULT: "hsl(var(--destructive))",
                    foreground: "hsl(var(--destructive-foreground))",
                },
                warning: {
                    DEFAULT: "hsl(var(--warning))",
                    foreground: "hsl(var(--warning-foreground))",
                },
                muted: {
                    DEFAULT: "hsl(var(--muted))",
                    foreground: "hsl(var(--muted-foreground))",
                },
                accent: {
                    DEFAULT: "hsl(var(--accent))",
                    foreground: "hsl(var(--accent-foreground))",
                },
                card: {
                    DEFAULT: "hsl(var(--card))",
                    foreground: "hsl(var(--card-foreground))",
                },
                surface: {
                    DEFAULT: "hsl(var(--surface))",
                    hover: "hsl(var(--surface-hover))",
                    active: "hsl(var(--surface-active))",
                },
                log: {
                    bg: "hsl(var(--log-bg))",
                    text: "hsl(var(--log-text))",
                    highlight: "hsl(var(--log-highlight))",
                },
                status: {
                    running: "hsl(var(--status-running))",
                    stopped: "hsl(var(--status-stopped))",
                    idle: "hsl(var(--status-idle))",
                },
            },
            borderRadius: {
                lg: "var(--radius)",
                md: "calc(var(--radius) - 2px)",
                sm: "calc(var(--radius) - 4px)",
            },
            keyframes: {
                "pulse-dot": {
                    "0%, 100%": { opacity: "1" },
                    "50%": { opacity: "0.55" },
                },
            },
            animation: {
                "pulse-dot": "pulse-dot 2s ease-in-out infinite",
            },
        },
    },
    plugins: [],
}
