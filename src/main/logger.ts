import pino from "pino"
import pinoPretty from "pino-pretty"
import { logs, SeverityNumber } from "@opentelemetry/api-logs"
import { LoggerProvider, SimpleLogRecordProcessor, InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs"

const isDev = process.env.NODE_ENV === "development" || Boolean(process.env.ELECTRON_RENDERER_URL)

const otelExporter = new InMemoryLogRecordExporter()
const otelProvider = new LoggerProvider({
    resource: undefined,
    processors: [new SimpleLogRecordProcessor(otelExporter)],
})
logs.setGlobalLoggerProvider(otelProvider)
const otelLogger = logs.getLogger("oprocs", "0.1.0")

const stream = isDev
    ? pinoPretty({ colorize: true, translateTime: "SYS:HH:MM:ss", hideObject: true })
    : pino.destination(1)
const pinoLogger = pino(
    { level: isDev ? "debug" : "info", base: { name: "oprocs" } },
    stream,
)
const lockLogger = pinoLogger.child({ module: "lock" })

const formatMsg = (msg: string, ...args: unknown[]) => {
    if (args.length === 0) return msg
    let i = 0
    const formatted = msg.replace(/%s/g, () => String(args[i++]))
    const rest = args.slice(i)
    return rest.length > 0 ? formatted + " " + rest.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") : formatted
}

export const log = {
    debug: (msg: string, ...args: unknown[]) => {
        lockLogger.debug(formatMsg(msg, ...args))
        otelLogger.emit({
            severityNumber: SeverityNumber.DEBUG,
            severityText: "DEBUG",
            body: formatMsg(msg, ...args),
            attributes: { "log.module": "lock" },
        })
    },
    info: (msg: string, ...args: unknown[]) => {
        lockLogger.info(formatMsg(msg, ...args))
        otelLogger.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            body: formatMsg(msg, ...args),
            attributes: { "log.module": "lock" },
        })
    },
    warn: (msg: string, ...args: unknown[]) => {
        lockLogger.warn(formatMsg(msg, ...args))
        otelLogger.emit({
            severityNumber: SeverityNumber.WARN,
            severityText: "WARN",
            body: formatMsg(msg, ...args),
            attributes: { "log.module": "lock" },
        })
    },
    error: (msg: string, ...args: unknown[]) => {
        lockLogger.error(formatMsg(msg, ...args))
        otelLogger.emit({
            severityNumber: SeverityNumber.ERROR,
            severityText: "ERROR",
            body: formatMsg(msg, ...args),
            attributes: { "log.module": "lock" },
        })
    },
}
