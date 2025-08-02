import { createLogger, format, transports } from "winston";
const developmentLogger = () => {
  const { combine, colorize, timestamp, printf } = format;
  const myFormat = printf(({ level, message, timestamp }) => {
    return `${timestamp} [${level}]:${message}`;
  });
  return createLogger({
    level: "debug",
    format: combine(
      colorize(),
      timestamp({ format: "YYYY-MM-DD HH:MM:SS" }),
      myFormat
    ),
    transports: [new transports.Console()],
  });
};

export default developmentLogger;
