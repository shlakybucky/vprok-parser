import winston from "winston";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = path.resolve(__dirname, "../../logs");

if(!fs.existsSync(logDir)){
    fs.mkdirSync(logDir);
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: winston.format.combine(
        winston.format.timestamp({ format: "YY-MM-DD HH:mm:ss" }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, stack }) => {
            const base = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
            return stack ? `${base}\n${stack}` : base;
        })
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),

        new winston.transports.File({
            filename: path.join(logDir, "errors.log"),
            level: "error"
        }),

        new winston.transports.File({
            filename: path.join(logDir, "combined.lod")
        })
    ],

    exitOnError: false
});

export default logger;